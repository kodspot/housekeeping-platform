'use strict';

const { z } = require('zod');
const PDFDocument = require('pdfkit');
const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');

const VALID_STATUSES = ['PRESENT', 'ABSENT', 'LEAVE', 'HALF_DAY'];
const VALID_SHIFTS = ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL'];

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

async function attendanceRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN', 'SUPERVISOR'));

  // ── Get attendance for a date/shift/location ──
  // Workers come from DutyRoster (if rosterId or locationId provided)
  fastify.get('/attendance', async (request, reply) => {
    const orgId = request.user.orgId;
    const { date, shift, locationId, rosterId } = request.query;

    if (!date || !isValidDateStr(date)) {
      return reply.code(400).send({ error: 'Valid date parameter required (YYYY-MM-DD)' });
    }

    const dateObj = new Date(date + 'T00:00:00Z');
    const where = { orgId, date: dateObj };
    if (shift && VALID_SHIFTS.includes(shift)) where.shift = shift;

    // Determine which workers to show
    let rosterWorkerIds = null;

    if (rosterId) {
      // Get workers from specific roster
      const rosterWorkers = await prisma.dutyRosterWorker.findMany({
        where: { rosterId, roster: { orgId } },
        select: { workerId: true }
      });
      rosterWorkerIds = rosterWorkers.map(rw => rw.workerId);
    } else if (locationId && shift) {
      // Get workers from duty roster(s) for this location/date/shift
      const rosters = await prisma.dutyRoster.findMany({
        where: { orgId, date: dateObj, shift, locationId },
        select: { id: true }
      });
      if (rosters.length > 0) {
        const rosterWorkers = await prisma.dutyRosterWorker.findMany({
          where: { rosterId: { in: rosters.map(r => r.id) } },
          select: { workerId: true }
        });
        rosterWorkerIds = rosterWorkers.map(rw => rw.workerId);
      } else {
        // Location selected but no rosters — empty result
        rosterWorkerIds = [];
      }
    }

    // If roster/location was requested but resolved to zero workers, return empty
    if (rosterWorkerIds !== null && rosterWorkerIds.length === 0) {
      return {
        records: [],
        summary: { present: 0, absent: 0, leave: 0, halfDay: 0, unmarked: 0, total: 0 }
      };
    }

    // Filter attendance by roster workers if available
    if (rosterWorkerIds && rosterWorkerIds.length > 0) {
      where.workerId = { in: rosterWorkerIds };
    }

    // Get existing attendance records
    const records = await prisma.attendance.findMany({
      where,
      include: {
        worker: { select: { id: true, name: true, employeeId: true, isActive: true } },
        markedBy: { select: { id: true, name: true } }
      },
      orderBy: { worker: { name: 'asc' } }
    });

    // Get all workers that should appear
    let allWorkers;
    if (rosterWorkerIds && rosterWorkerIds.length > 0) {
      allWorkers = await prisma.worker.findMany({
        where: { id: { in: rosterWorkerIds }, orgId, isActive: true },
        select: { id: true, name: true, employeeId: true, isActive: true },
        orderBy: { name: 'asc' }
      });
    } else if (!locationId && !rosterId) {
      // No filter — all active workers
      allWorkers = await prisma.worker.findMany({
        where: { orgId, isActive: true },
        select: { id: true, name: true, employeeId: true, isActive: true },
        orderBy: { name: 'asc' }
      });
    } else {
      allWorkers = [];
    }

    // Merge: workers with records + workers without records (unmarked)
    const result = [];
    const recordMap = {};
    for (const r of records) {
      recordMap[r.workerId] = r;
    }

    for (const w of allWorkers) {
      if (recordMap[w.id]) {
        const r = recordMap[w.id];
        result.push({
          attendanceId: r.id,
          worker: w,
          status: r.status,
          shift: r.shift,
          note: r.note,
          markedBy: r.markedBy,
          createdAt: r.createdAt
        });
      } else {
        result.push({
          attendanceId: null,
          worker: w,
          status: null,
          shift: shift || null,
          note: null,
          markedBy: null,
          createdAt: null
        });
      }
    }

    // Also add records for workers not in the allWorkers list (edge case: unassigned but marked)
    for (const r of records) {
      if (!allWorkers.find(w => w.id === r.workerId)) {
        result.push({
          attendanceId: r.id,
          worker: r.worker,
          status: r.status,
          shift: r.shift,
          note: r.note,
          markedBy: r.markedBy,
          createdAt: r.createdAt
        });
      }
    }

    // Summary stats
    let present = 0, absent = 0, leave = 0, halfDay = 0, unmarked = 0;
    for (const r of result) {
      if (!r.status) unmarked++;
      else if (r.status === 'PRESENT') present++;
      else if (r.status === 'ABSENT') absent++;
      else if (r.status === 'LEAVE') leave++;
      else if (r.status === 'HALF_DAY') halfDay++;
    }

    return {
      records: result,
      summary: { present, absent, leave, halfDay, unmarked, total: result.length }
    };
  });

  // ── Bulk mark attendance (create or update) ──
  fastify.post('/attendance/bulk', async (request, reply) => {
    const orgId = request.user.orgId;

    const schema = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      shift: z.enum(VALID_SHIFTS),
      records: z.array(z.object({
        workerId: z.string().uuid(),
        status: z.enum(VALID_STATUSES),
        note: z.string().max(500).optional().nullable()
      })).min(1).max(200)
    });

    const data = schema.parse(request.body);

    if (!isValidDateStr(data.date)) {
      return reply.code(400).send({ error: 'Invalid date' });
    }

    // Only allow today or yesterday (admins can override)
    const dateObj = new Date(data.date + 'T00:00:00Z');
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (request.user.role !== 'ADMIN') {
      if (dateObj < yesterday) {
        return reply.code(400).send({ error: 'Supervisors can only mark attendance for today or yesterday' });
      }
    }

    // Validate all workers belong to org and are active
    const workerIds = data.records.map(r => r.workerId);
    const workers = await prisma.worker.findMany({
      where: { id: { in: workerIds }, orgId, isActive: true },
      select: { id: true }
    });
    if (workers.length !== new Set(workerIds).size) {
      return reply.code(400).send({ error: 'One or more workers not found or inactive' });
    }

    // Upsert all records in a transaction for atomicity
    const results = await prisma.$transaction(
      data.records.map(rec => prisma.attendance.upsert({
        where: {
          workerId_date_shift: {
            workerId: rec.workerId,
            date: dateObj,
            shift: data.shift
          }
        },
        create: {
          orgId,
          workerId: rec.workerId,
          markedById: request.user.id,
          date: dateObj,
          shift: data.shift,
          status: rec.status,
          note: rec.note?.trim() || null
        },
        update: {
          status: rec.status,
          note: rec.note?.trim() || null,
          markedById: request.user.id
        }
      }))
    );

    await prisma.auditLog.create({
      data: {
        orgId,
        actorType: request.user.role === 'ADMIN' ? 'admin' : 'supervisor',
        actorId: request.user.id,
        action: 'attendance_marked',
        entityType: 'Attendance',
        newValue: { date: data.date, shift: data.shift, count: data.records.length }
      }
    });

    return { success: true, count: results.length };
  });

  // ── Update single attendance record ──
  fastify.patch('/attendance/:id', async (request, reply) => {
    const { id } = request.params;
    const orgId = request.user.orgId;

    const schema = z.object({
      status: z.enum(VALID_STATUSES).optional(),
      note: z.string().max(500).optional().nullable()
    });

    const data = schema.parse(request.body);

    const record = await prisma.attendance.findFirst({ where: { id, orgId } });
    if (!record) return reply.code(404).send({ error: 'Attendance record not found' });

    // Supervisors can only edit their own markings
    if (request.user.role === 'SUPERVISOR' && record.markedById !== request.user.id) {
      return reply.code(403).send({ error: 'You can only edit attendance you marked' });
    }

    const updateData = {};
    if (data.status) updateData.status = data.status;
    if (data.note !== undefined) updateData.note = data.note?.trim() || null;
    updateData.markedById = request.user.id;

    const updated = await prisma.attendance.update({
      where: { id },
      data: updateData,
      include: {
        worker: { select: { id: true, name: true, employeeId: true } },
        markedBy: { select: { id: true, name: true } }
      }
    });

    return updated;
  });

  // ── Attendance report (aggregated stats) ──
  fastify.get('/attendance/report', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { from, to, workerId, locationId, shift } = request.query;

    if (!from || !to || !isValidDateStr(from) || !isValidDateStr(to)) {
      return reply.code(400).send({ error: 'Valid from and to date parameters required (YYYY-MM-DD)' });
    }

    const fromDate = new Date(from + 'T00:00:00Z');
    const toDate = new Date(to + 'T00:00:00Z');

    const where = {
      orgId,
      date: { gte: fromDate, lte: toDate }
    };
    if (shift && VALID_SHIFTS.includes(shift)) where.shift = shift;

    // Build worker filter: combine workerId and locationId if both provided
    let workerIdFilter = null;
    if (workerId) workerIdFilter = [workerId];
    if (locationId) {
      // Get workers from all duty rosters for this location in the date range
      const rosters = await prisma.dutyRoster.findMany({
        where: { orgId, locationId, date: { gte: fromDate, lte: toDate }, ...(shift ? { shift } : {}) },
        select: { id: true }
      });
      const rosterWorkers = rosters.length > 0
        ? await prisma.dutyRosterWorker.findMany({
            where: { rosterId: { in: rosters.map(r => r.id) } },
            select: { workerId: true },
            distinct: ['workerId']
          })
        : [];
      const locationWorkerIds = rosterWorkers.map(rw => rw.workerId);
      if (workerIdFilter) {
        const set = new Set(locationWorkerIds);
        workerIdFilter = workerIdFilter.filter(id => set.has(id));
      } else {
        workerIdFilter = locationWorkerIds;
      }
    }
    if (workerIdFilter) where.workerId = workerIdFilter.length === 1 ? workerIdFilter[0] : { in: workerIdFilter };

    // Get all records
    const records = await prisma.attendance.findMany({
      where,
      include: {
        worker: { select: { id: true, name: true, employeeId: true } }
      },
      orderBy: [{ date: 'asc' }, { worker: { name: 'asc' } }]
    });

    // Aggregate per worker
    const workerStats = {};
    for (const r of records) {
      if (!workerStats[r.workerId]) {
        workerStats[r.workerId] = {
          worker: r.worker,
          present: 0, absent: 0, leave: 0, halfDay: 0, total: 0
        };
      }
      const s = workerStats[r.workerId];
      s.total++;
      if (r.status === 'PRESENT') s.present++;
      else if (r.status === 'ABSENT') s.absent++;
      else if (r.status === 'LEAVE') s.leave++;
      else if (r.status === 'HALF_DAY') s.halfDay++;
    }

    // Calculate percentages
    const workerSummaries = Object.values(workerStats).map(s => ({
      ...s,
      attendancePercent: s.total > 0 ? Math.round(((s.present + s.halfDay * 0.5) / s.total) * 100) : 0
    }));
    workerSummaries.sort((a, b) => a.worker.name.localeCompare(b.worker.name));

    // Overall summary
    let totalPresent = 0, totalAbsent = 0, totalLeave = 0, totalHalfDay = 0, totalRecords = 0;
    for (const s of workerSummaries) {
      totalPresent += s.present;
      totalAbsent += s.absent;
      totalLeave += s.leave;
      totalHalfDay += s.halfDay;
      totalRecords += s.total;
    }

    return {
      workers: workerSummaries,
      summary: {
        totalRecords,
        present: totalPresent,
        absent: totalAbsent,
        leave: totalLeave,
        halfDay: totalHalfDay,
        attendancePercent: totalRecords > 0 ? Math.round(((totalPresent + totalHalfDay * 0.5) / totalRecords) * 100) : 0
      },
      dateRange: { from, to }
    };
  });

  // ── Download attendance report as PDF ──
  fastify.get('/attendance/report/pdf', {
    preHandler: [requireRole('ADMIN')]
  }, async (request, reply) => {
    const orgId = request.user.orgId;
    const { from, to, workerId, locationId, shift } = request.query;

    if (!from || !to || !isValidDateStr(from) || !isValidDateStr(to)) {
      return reply.code(400).send({ error: 'Valid from and to dates required' });
    }

    const fromDate = new Date(from + 'T00:00:00Z');
    const toDate = new Date(to + 'T00:00:00Z');

    // Build query (same logic as report endpoint)
    const where = { orgId, date: { gte: fromDate, lte: toDate } };
    if (shift && VALID_SHIFTS.includes(shift)) where.shift = shift;
    let workerIdFilter = null;
    if (workerId) workerIdFilter = [workerId];
    if (locationId) {
      const rosters = await prisma.dutyRoster.findMany({
        where: { orgId, locationId, date: { gte: fromDate, lte: toDate }, ...(shift ? { shift } : {}) },
        select: { id: true }
      });
      const rw = rosters.length > 0
        ? await prisma.dutyRosterWorker.findMany({
            where: { rosterId: { in: rosters.map(r => r.id) } },
            select: { workerId: true },
            distinct: ['workerId']
          })
        : [];
      const locIds = rw.map(r => r.workerId);
      if (workerIdFilter) {
        const set = new Set(locIds);
        workerIdFilter = workerIdFilter.filter(id => set.has(id));
      } else {
        workerIdFilter = locIds;
      }
    }
    if (workerIdFilter) where.workerId = workerIdFilter.length === 1 ? workerIdFilter[0] : { in: workerIdFilter };

    const records = await prisma.attendance.findMany({
      where,
      include: { worker: { select: { id: true, name: true, employeeId: true } } },
      orderBy: [{ date: 'asc' }, { worker: { name: 'asc' } }]
    });

    // Aggregate per worker
    const workerStats = {};
    for (const r of records) {
      if (!workerStats[r.workerId]) {
        workerStats[r.workerId] = { worker: r.worker, present: 0, absent: 0, leave: 0, halfDay: 0, total: 0 };
      }
      const s = workerStats[r.workerId];
      s.total++;
      if (r.status === 'PRESENT') s.present++;
      else if (r.status === 'ABSENT') s.absent++;
      else if (r.status === 'LEAVE') s.leave++;
      else if (r.status === 'HALF_DAY') s.halfDay++;
    }

    const rows = Object.values(workerStats).map(s => ({
      ...s,
      attendancePercent: s.total > 0 ? Math.round(((s.present + s.halfDay * 0.5) / s.total) * 100) : 0
    }));
    rows.sort((a, b) => a.worker.name.localeCompare(b.worker.name));

    let totP = 0, totA = 0, totL = 0, totH = 0, totR = 0;
    for (const s of rows) { totP += s.present; totA += s.absent; totL += s.leave; totH += s.halfDay; totR += s.total; }
    const avgPct = totR > 0 ? Math.round(((totP + totH * 0.5) / totR) * 100) : 0;

    // Resolve location name if filter was used
    let locationLabel = null;
    if (locationId) {
      const loc = await prisma.location.findFirst({
        where: { id: locationId, orgId },
        select: { name: true, parent: { select: { name: true } } }
      });
      if (loc) locationLabel = loc.parent ? loc.parent.name + ' → ' + loc.name : loc.name;
    }

    // Resolve org name
    const org = await prisma.organization.findFirst({ where: { id: orgId }, select: { name: true } });
    const orgName = org?.name || 'Organization';

    // ── Generate PDF ──
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));

    const pdfReady = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const pageW = doc.page.width - 80; // usable width

    // Header
    doc.fontSize(16).font('Helvetica-Bold').text('Attendance Report', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#555555')
      .text(orgName, { align: 'center' });
    doc.moveDown(0.6);

    // Info line
    const fromFmt = new Date(from + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const toFmt = new Date(to + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    let infoLine = 'Period: ' + fromFmt + '  to  ' + toFmt;
    if (shift) infoLine += '   |   Shift: ' + shift.charAt(0) + shift.slice(1).toLowerCase();
    if (locationLabel) infoLine += '   |   Location: ' + locationLabel;
    doc.fontSize(9).fillColor('#333333').text(infoLine, { align: 'center' });
    doc.moveDown(0.8);

    // Summary box
    doc.save();
    const boxY = doc.y;
    doc.roundedRect(40, boxY, pageW, 50, 4).fillAndStroke('#f0fdf4', '#d1fae5');
    doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold');
    const sY = boxY + 12;
    const colW = pageW / 6;
    const summaryItems = [
      ['Total Records', String(totR)],
      ['Present', String(totP)],
      ['Absent', String(totA)],
      ['Leave', String(totL)],
      ['Half Day', String(totH)],
      ['Avg Attendance', avgPct + '%']
    ];
    for (let i = 0; i < summaryItems.length; i++) {
      const x = 40 + i * colW;
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#166534').text(summaryItems[i][1], x, sY, { width: colW, align: 'center' });
      doc.fontSize(7).font('Helvetica').fillColor('#555555').text(summaryItems[i][0], x, sY + 16, { width: colW, align: 'center' });
    }
    doc.restore();
    doc.y = boxY + 60;

    // Table
    const cols = [
      { label: '#', width: 25 },
      { label: 'Worker Name', width: pageW * 0.25 },
      { label: 'Employee ID', width: pageW * 0.15 },
      { label: 'Present', width: pageW * 0.1 },
      { label: 'Absent', width: pageW * 0.1 },
      { label: 'Leave', width: pageW * 0.1 },
      { label: 'Half Day', width: pageW * 0.1 },
      { label: 'Attendance %', width: pageW * 0.15 + 15 }
    ];

    function drawTableHeader(startY) {
      doc.save();
      doc.rect(40, startY, pageW, 22).fill('#0d9488');
      let cx = 40;
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff');
      for (const col of cols) {
        doc.text(col.label, cx + 4, startY + 6, { width: col.width - 8, align: col.label === '#' ? 'center' : 'left' });
        cx += col.width;
      }
      doc.restore();
      return startY + 22;
    }

    function drawTableRow(row, idx, startY) {
      const bg = idx % 2 === 0 ? '#ffffff' : '#f8fafc';
      doc.save();
      doc.rect(40, startY, pageW, 20).fill(bg);
      // Subtle border
      doc.moveTo(40, startY + 20).lineTo(40 + pageW, startY + 20).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
      let cx = 40;
      doc.fontSize(8).font('Helvetica').fillColor('#334155');
      const vals = [
        String(idx + 1),
        row.worker.name,
        row.worker.employeeId || '—',
        String(row.present),
        String(row.absent),
        String(row.leave),
        String(row.halfDay),
        row.attendancePercent + '%'
      ];
      for (let i = 0; i < cols.length; i++) {
        const align = i === 0 ? 'center' : 'left';
        // Color coding for attendance %
        if (i === 7) {
          const pct = row.attendancePercent;
          doc.fillColor(pct >= 80 ? '#166534' : pct >= 50 ? '#92400e' : '#991b1b');
          doc.font('Helvetica-Bold');
        } else if (i >= 3 && i <= 6) {
          doc.font('Helvetica');
          doc.fillColor('#334155');
        }
        doc.text(vals[i], cx + 4, startY + 5, { width: cols[i].width - 8, align });
        cx += cols[i].width;
      }
      doc.restore();
      return startY + 20;
    }

    let tableY = drawTableHeader(doc.y);

    for (let i = 0; i < rows.length; i++) {
      // Check if we need a new page
      if (tableY + 24 > doc.page.height - 60) {
        doc.addPage();
        tableY = drawTableHeader(40);
      }
      tableY = drawTableRow(rows[i], i, tableY);
    }

    if (rows.length === 0) {
      doc.moveDown(1);
      doc.fontSize(10).font('Helvetica').fillColor('#999999').text('No attendance records found for this period.', { align: 'center' });
    }

    // Footer — bottom of last page
    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    doc.fontSize(7).font('Helvetica').fillColor('#999999');
    doc.text('Generated on ' + now + '  |  ' + orgName, 40, doc.page.height - 35, { width: pageW, align: 'center' });

    doc.end();

    const buffer = await pdfReady;
    const filename = 'attendance-report-' + from + '-to-' + to + '.pdf';

    return reply
      .type('application/pdf')
      .header('Content-Disposition', 'attachment; filename="' + filename + '"')
      .send(buffer);
  });

  // ── Today's attendance overview (for dashboard) ──
  fastify.get('/attendance/today', async (request) => {
    const orgId = request.user.orgId;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const records = await prisma.attendance.findMany({
      where: { orgId, date: today },
      select: { workerId: true, status: true }
    });

    const totalWorkers = await prisma.worker.count({ where: { orgId, isActive: true } });

    // Deduplicate across shifts: per worker, keep most-favorable status
    const PRIO = { PRESENT: 4, HALF_DAY: 3, LEAVE: 2, ABSENT: 1 };
    const workerBest = {};
    for (const r of records) {
      const cur = workerBest[r.workerId];
      if (!cur || (PRIO[r.status] || 0) > (PRIO[cur] || 0)) {
        workerBest[r.workerId] = r.status;
      }
    }

    const stats = { present: 0, absent: 0, leave: 0, halfDay: 0, marked: 0 };
    for (const status of Object.values(workerBest)) {
      if (status === 'PRESENT') stats.present++;
      else if (status === 'ABSENT') stats.absent++;
      else if (status === 'LEAVE') stats.leave++;
      else if (status === 'HALF_DAY') stats.halfDay++;
      stats.marked++;
    }
    stats.unmarked = Math.max(0, totalWorkers - stats.marked);
    stats.totalWorkers = totalWorkers;

    return stats;
  });

  // ── Floors with rostered workers (for attendance dropdowns) ──
  fastify.get('/attendance/floors', async (request) => {
    const orgId = request.user.orgId;
    const { date, shift } = request.query;
    const isAdmin = request.user.role !== 'SUPERVISOR';

    // Get roster data for the date/shift
    const rosterWhere = { orgId };
    if (date && isValidDateStr(date)) rosterWhere.date = new Date(date + 'T00:00:00Z');
    if (shift && VALID_SHIFTS.includes(shift)) rosterWhere.shift = shift;
    if (!isAdmin) rosterWhere.supervisorId = request.user.id;

    const rosters = await prisma.dutyRoster.findMany({
      where: rosterWhere,
      select: {
        id: true,
        locationId: true,
        location: {
          select: { id: true, name: true, type: true, parent: { select: { name: true } } }
        },
        supervisor: { select: { name: true } },
        _count: { select: { workers: true } }
      },
      orderBy: [{ location: { parent: { name: 'asc' } } }, { location: { name: 'asc' } }]
    });

    // Build roster map keyed by locationId
    const rosterByLoc = {};
    for (const r of rosters) {
      rosterByLoc[r.locationId] = r;
    }

    // For admin: get floor-level locations (direct children of buildings) grouped by building
    if (isAdmin) {
      // Step 1: get all top-level buildings
      const buildings = await prisma.location.findMany({
        where: { orgId, isActive: true, parentId: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' }
      });

      // Step 2: get floor-level locations (direct children of buildings)
      const buildingIds = buildings.map(b => b.id);
      const floorLocations = await prisma.location.findMany({
        where: { orgId, isActive: true, parentId: { in: buildingIds } },
        select: { id: true, name: true, type: true, parentId: true },
        orderBy: { name: 'asc' }
      });

      // Build building name map
      const buildingMap = {};
      for (const b of buildings) buildingMap[b.id] = b.name;

      // Group floors by building
      const groups = [];
      for (const b of buildings) {
        const bFloors = floorLocations.filter(f => f.parentId === b.id);
        if (!bFloors.length) continue;
        groups.push({
          building: b.name,
          floors: bFloors.map(f => {
            const r = rosterByLoc[f.id];
            return {
              id: f.id,
              rosterId: r ? r.id : null,
              name: f.name,
              type: f.type,
              supervisorName: r ? r.supervisor.name : null,
              workerCount: r ? r._count.workers : 0
            };
          })
        });
      }

      return { groups };
    }

    // For supervisor: only rostered floors
    return {
      floors: rosters.map(r => ({
        id: r.location.id,
        rosterId: r.id,
        name: r.location.name,
        type: r.location.type,
        parentName: r.location.parent?.name || null,
        supervisorName: r.supervisor.name,
        workerCount: r._count.workers
      }))
    };
  });
}

module.exports = attendanceRoutes;
