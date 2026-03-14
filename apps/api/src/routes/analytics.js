'use strict';

const { prisma } = require('../lib/prisma');
const { authenticateJWT, requireRole } = require('../middleware/auth');

async function analyticsRoutes(fastify, opts) {
  fastify.addHook('preHandler', authenticateJWT);
  fastify.addHook('preHandler', requireRole('ADMIN'));

  // Dashboard overview
  fastify.get('/analytics/dashboard', async (request) => {
    const orgId = request.user.orgId;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const weekAgo = new Date(todayStart);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [
      totalLocations,
      activeWorkers,
      activeSupervisors,
      todayRecords,
      yesterdayRecords,
      weekRecords,
      openTickets,
      totalRecords,
      scheduledCount,
      schedules,
      todayCleaningShifts
    ] = await Promise.all([
      prisma.location.count({ where: { orgId, isActive: true, type: { notIn: ['BUILDING', 'FLOOR'] } } }),
      prisma.worker.count({ where: { orgId, isActive: true } }),
      prisma.user.count({ where: { orgId, role: 'SUPERVISOR', isActive: true } }),
      prisma.cleaningRecord.count({ where: { orgId, cleanedAt: { gte: todayStart } } }),
      prisma.cleaningRecord.count({ where: { orgId, cleanedAt: { gte: yesterdayStart, lt: todayStart } } }),
      prisma.cleaningRecord.count({ where: { orgId, cleanedAt: { gte: weekAgo } } }),
      prisma.ticket.count({ where: { orgId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.cleaningRecord.count({ where: { orgId } }),
      prisma.cleaningSchedule.count({ where: { orgId, isActive: true } }),
      // Fetch schedules with shifts for progress calculation
      prisma.cleaningSchedule.findMany({
        where: { orgId, isActive: true },
        select: { locationId: true, shifts: true }
      }),
      // Today's cleaning records (shift + location) for progress
      prisma.cleaningRecord.findMany({
        where: { orgId, cleanedAt: { gte: todayStart, lte: todayEnd } },
        select: { locationId: true, shift: true }
      })
    ]);

    const weeklyAvg = weekRecords > 0 ? Math.round(weekRecords / 7 * 10) / 10 : 0;

    // Calculate shift-wise progress
    const shiftRequired = { MORNING: 0, AFTERNOON: 0, NIGHT: 0, GENERAL: 0 };
    const shiftDone = { MORNING: 0, AFTERNOON: 0, NIGHT: 0, GENERAL: 0 };
    const completedSet = new Set();
    for (const rec of todayCleaningShifts) {
      completedSet.add(rec.locationId + '|' + rec.shift);
    }
    let totalRequired = 0;
    let totalDone = 0;
    for (const sched of schedules) {
      for (const shift of sched.shifts) {
        shiftRequired[shift] = (shiftRequired[shift] || 0) + 1;
        totalRequired++;
        if (completedSet.has(sched.locationId + '|' + shift)) {
          shiftDone[shift] = (shiftDone[shift] || 0) + 1;
          totalDone++;
        }
      }
    }
    const completionRate = totalRequired > 0 ? Math.round(totalDone / totalRequired * 100) : null;

    return {
      totalLocations,
      activeWorkers,
      activeSupervisors,
      todayRecords,
      yesterdayRecords,
      weeklyAvg,
      openTickets,
      totalRecords,
      scheduledLocations: scheduledCount,
      completionRate,
      shiftProgress: {
        MORNING: { required: shiftRequired.MORNING, done: shiftDone.MORNING },
        AFTERNOON: { required: shiftRequired.AFTERNOON, done: shiftDone.AFTERNOON },
        NIGHT: { required: shiftRequired.NIGHT, done: shiftDone.NIGHT },
        GENERAL: { required: shiftRequired.GENERAL, done: shiftDone.GENERAL }
      }
    };
  });

  // Per-worker cleaning performance (for admin dashboard)
  fastify.get('/analytics/worker-performance', async (request) => {
    const orgId = request.user.orgId;
    const days = Math.min(parseInt(request.query.days) || 30, 365);
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const workers = await prisma.worker.findMany({
      where: { orgId },
      select: {
        id: true, employeeId: true, name: true, isActive: true,
        cleaningRecords: {
          where: { cleanedAt: { gte: since } },
          select: { cleanedAt: true, _count: { select: { images: true } } },
          orderBy: { cleanedAt: 'desc' }
        }
      },
      orderBy: { name: 'asc' }
    });

    return { days, workers: workers.map(w => ({
      id: w.id,
      employeeId: w.employeeId,
      name: w.name,
      isActive: w.isActive,
      totalRecords: w.cleaningRecords.length,
      totalImages: w.cleaningRecords.reduce((s, r) => s + r._count.images, 0),
      lastCleaningAt: w.cleaningRecords[0]?.cleanedAt || null
    })) };
  });

  // Cleaning activity trend (daily counts for last N days)
  fastify.get('/analytics/cleaning-trend', async (request) => {
    const orgId = request.user.orgId;
    const days = Math.min(parseInt(request.query.days) || 7, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const trend = await prisma.$queryRaw`
      SELECT DATE("cleanedAt") as date, COUNT(*)::int as count
       FROM "CleaningRecord"
       WHERE "orgId"::text = ${orgId} AND "cleanedAt" >= ${since}
       GROUP BY DATE("cleanedAt")
       ORDER BY date ASC`;

    // Fill in all days in range (include 0-count days for proper chart)
    const allDays = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      allDays.push(d.toISOString().split('T')[0]);
    }
    const countMap = new Map((trend || []).map(d => {
      const dateStr = typeof d.date === 'string' ? d.date.split('T')[0] : new Date(d.date).toISOString().split('T')[0];
      return [dateStr, d.count];
    }));
    return { trend: allDays.map(date => ({ date, count: countMap.get(date) || 0 })) };
  });

  // Worker performance — ranked with flagged records, ticket correlation, supervisor associations
  fastify.get('/analytics/workers', async (request) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    // Query 1: workers + their cleaning records (status, locationId, supervisor)
    const workers = await prisma.worker.findMany({
      where: { orgId, isActive: true },
      select: {
        id: true, name: true, phone: true,
        cleaningRecords: {
          where: hasDateFilter ? { cleanedAt: dateFilter } : undefined,
          select: {
            id: true,
            status: true,
            locationId: true,
            supervisor: { select: { id: true, name: true } }
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    // Collect all unique location IDs across all workers' records
    const allLocationIds = new Set();
    for (const w of workers) {
      for (const r of w.cleaningRecords) allLocationIds.add(r.locationId);
    }

    // Query 2: ticket counts grouped by locationId for those locations
    let ticketsByLocation = new Map();
    if (allLocationIds.size > 0) {
      const ticketGroups = await prisma.ticket.groupBy({
        by: ['locationId'],
        where: {
          orgId,
          locationId: { in: [...allLocationIds] },
          ...(hasDateFilter ? { createdAt: dateFilter } : {})
        },
        _count: true
      });
      for (const g of ticketGroups) ticketsByLocation.set(g.locationId, g._count);
    }

    // Build performance metrics per worker
    const result = workers.map(w => {
      const records = w.cleaningRecords;
      const cleaningCount = records.length;
      const flaggedCount = records.filter(r => r.status === 'FLAGGED').length;

      // Tickets at locations this worker cleaned
      const workerLocationIds = new Set(records.map(r => r.locationId));
      let locationTicketCount = 0;
      for (const locId of workerLocationIds) {
        locationTicketCount += ticketsByLocation.get(locId) || 0;
      }

      // Unique supervisors this worker worked with
      const supMap = new Map();
      for (const r of records) {
        if (r.supervisor && !supMap.has(r.supervisor.id)) {
          supMap.set(r.supervisor.id, r.supervisor.name);
        }
      }
      const supervisors = [...supMap.entries()].map(([id, name]) => ({ id, name }));

      // Performance score: cleanings are positive, flags & tickets are negative
      const score = cleaningCount - (flaggedCount * 3) - (locationTicketCount * 1);

      return {
        id: w.id,
        name: w.name,
        phone: w.phone,
        cleaningCount,
        flaggedCount,
        locationTicketCount,
        supervisors,
        score
      };
    });

    // Sort by score descending (best performers first)
    result.sort((a, b) => b.score - a.score);
    return result;
  });

  // Location cleaning history
  fastify.get('/analytics/locations', async (request) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const locations = await prisma.location.findMany({
      where: { orgId, isActive: true },
      select: {
        id: true, name: true, type: true,
        cleaningRecords: {
          where: Object.keys(dateFilter).length ? { cleanedAt: dateFilter } : undefined,
          select: { id: true }
        },
        cleaningSchedules: {
          select: { frequency: true, shifts: true }
        }
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }]
    });

    return locations.map(l => ({
      id: l.id,
      name: l.name,
      type: l.type,
      cleaningCount: l.cleaningRecords.length,
      schedule: l.cleaningSchedules[0] || null
    }));
  });

  // Supervisor activity
  fastify.get('/analytics/supervisors', async (request) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const supervisors = await prisma.user.findMany({
      where: { orgId, role: 'SUPERVISOR', isActive: true },
      select: {
        id: true, name: true, email: true,
        cleaningRecords: {
          where: Object.keys(dateFilter).length ? { cleanedAt: dateFilter } : undefined,
          select: { id: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    return supervisors.map(s => ({
      id: s.id,
      name: s.name,
      email: s.email,
      recordCount: s.cleaningRecords.length
    })).sort((a, b) => b.recordCount - a.recordCount);
  });

  // Overdue cleaning detection
  // Compares required shifts from CleaningSchedule against today's CleaningRecords
  fastify.get('/analytics/overdue', async (request) => {
    const orgId = request.user.orgId;
    const { date } = request.query;

    // Target date — defaults to today
    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);

    // Determine which shifts should be considered overdue by current time
    // Only flag shifts whose window has passed (avoids false positives for future shifts)
    const currentHour = new Date().getHours();
    const isToday = dayStart.toDateString() === new Date().toDateString();

    // Shift cutoff hours: MORNING ends at 12, AFTERNOON ends at 18, NIGHT ends at 6 (next day)
    // GENERAL has no fixed window — considered overdue only at end of day (23:00)
    const SHIFT_CUTOFFS = { MORNING: 12, AFTERNOON: 18, NIGHT: 23, GENERAL: 23 };

    function isShiftOverdue(shift) {
      if (!isToday) return true; // past dates: all shifts overdue
      return currentHour >= SHIFT_CUTOFFS[shift];
    }

    // 1. Fetch all active schedules for this org with location info
    //    Single query — filtered at DB level for performance
    const schedules = await prisma.cleaningSchedule.findMany({
      where: { orgId, isActive: true },
      select: {
        locationId: true,
        shifts: true,
        frequency: true,
        location: {
          select: {
            id: true, name: true, type: true, qrCode: true, isActive: true,
            parent: { select: { id: true, name: true, type: true } }
          }
        }
      }
    });

    // Filter to active locations only
    const activeSchedules = schedules.filter(s => s.location.isActive);
    if (activeSchedules.length === 0) return { overdue: [], summary: { total: 0, checked: 0 } };

    // 2. Fetch all cleaning records for these locations on the target date
    //    Single bulk query with orgId + date range index
    const locationIds = activeSchedules.map(s => s.locationId);

    const records = await prisma.cleaningRecord.findMany({
      where: {
        orgId,
        locationId: { in: locationIds },
        cleanedAt: { gte: dayStart, lte: dayEnd }
      },
      select: {
        locationId: true,
        shift: true,
        cleanedAt: true,
        supervisorId: true,
        supervisor: { select: { id: true, name: true } }
      }
    });

    // 3. Build a lookup: locationId → Set of completed shifts + last record info
    const completedMap = new Map();
    for (const rec of records) {
      if (!completedMap.has(rec.locationId)) {
        completedMap.set(rec.locationId, { shifts: new Set(), lastRecord: null });
      }
      const entry = completedMap.get(rec.locationId);
      entry.shifts.add(rec.shift);
      if (!entry.lastRecord || rec.cleanedAt > entry.lastRecord.cleanedAt) {
        entry.lastRecord = rec;
      }
    }

    // 4. Compare required vs completed and build overdue list
    const overdue = [];

    for (const schedule of activeSchedules) {
      const completed = completedMap.get(schedule.locationId);
      const completedShifts = completed ? completed.shifts : new Set();

      for (const requiredShift of schedule.shifts) {
        if (completedShifts.has(requiredShift)) continue;
        if (!isShiftOverdue(requiredShift)) continue;

        overdue.push({
          location: schedule.location,
          missingShift: requiredShift,
          scheduledFrequency: schedule.frequency,
          lastCleaningAt: completed?.lastRecord?.cleanedAt || null,
          lastSupervisor: completed?.lastRecord?.supervisor || null,
          date: dayStart.toISOString().split('T')[0]
        });
      }
    }

    // Sort: by location type, then name for consistent display
    overdue.sort((a, b) =>
      a.location.type.localeCompare(b.location.type) ||
      a.location.name.localeCompare(b.location.name) ||
      a.missingShift.localeCompare(b.missingShift)
    );

    return {
      overdue,
      summary: {
        total: overdue.length,
        checked: activeSchedules.length,
        date: dayStart.toISOString().split('T')[0],
        byShift: {
          MORNING: overdue.filter(o => o.missingShift === 'MORNING').length,
          AFTERNOON: overdue.filter(o => o.missingShift === 'AFTERNOON').length,
          NIGHT: overdue.filter(o => o.missingShift === 'NIGHT').length,
          GENERAL: overdue.filter(o => o.missingShift === 'GENERAL').length
        }
      }
    };
  });

  // Problem locations — combines overdue, flagged records, and tickets
  fastify.get('/analytics/problem-locations', async (request) => {
    const orgId = request.user.orgId;
    const { days } = request.query;

    const lookbackDays = Math.min(parseInt(days) || 7, 90);
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);
    since.setHours(0, 0, 0, 0);

    // 3 parallel queries across the lookback window
    const [flaggedRecords, openTickets, schedules] = await Promise.all([
      // Flagged cleaning records
      prisma.cleaningRecord.findMany({
        where: { orgId, status: 'FLAGGED', cleanedAt: { gte: since } },
        select: { locationId: true, cleanedAt: true }
      }),
      // Open/in-progress tickets
      prisma.ticket.findMany({
        where: { orgId, status: { in: ['OPEN', 'IN_PROGRESS'] }, createdAt: { gte: since } },
        select: { locationId: true, priority: true, createdAt: true }
      }),
      // Active schedules (for overdue calculation)
      prisma.cleaningSchedule.findMany({
        where: { orgId, isActive: true },
        select: { locationId: true, shifts: true }
      })
    ]);

    // Count overdue shifts for today
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const currentHour = new Date().getHours();
    const SHIFT_CUTOFFS = { MORNING: 12, AFTERNOON: 18, NIGHT: 23, GENERAL: 23 };

    const scheduledLocationIds = schedules.map(s => s.locationId);
    let todayRecords = [];
    if (scheduledLocationIds.length > 0) {
      todayRecords = await prisma.cleaningRecord.findMany({
        where: { orgId, locationId: { in: scheduledLocationIds }, cleanedAt: { gte: todayStart, lte: todayEnd } },
        select: { locationId: true, shift: true }
      });
    }

    const completedToday = new Map();
    for (const rec of todayRecords) {
      if (!completedToday.has(rec.locationId)) completedToday.set(rec.locationId, new Set());
      completedToday.get(rec.locationId).add(rec.shift);
    }

    // Build score per location
    const scoreMap = new Map();

    function getEntry(locationId) {
      if (!scoreMap.has(locationId)) {
        scoreMap.set(locationId, { flaggedCount: 0, ticketCount: 0, overdueShifts: 0, urgentTickets: 0, score: 0 });
      }
      return scoreMap.get(locationId);
    }

    for (const rec of flaggedRecords) {
      getEntry(rec.locationId).flaggedCount++;
    }

    for (const ticket of openTickets) {
      const entry = getEntry(ticket.locationId);
      entry.ticketCount++;
      if (ticket.priority === 'HIGH' || ticket.priority === 'URGENT') entry.urgentTickets++;
    }

    for (const schedule of schedules) {
      const done = completedToday.get(schedule.locationId) || new Set();
      let missed = 0;
      for (const shift of schedule.shifts) {
        if (!done.has(shift) && currentHour >= SHIFT_CUTOFFS[shift]) missed++;
      }
      if (missed > 0) getEntry(schedule.locationId).overdueShifts = missed;
    }

    // Weighted score: overdue matters most, then flagged, then tickets, urgent tickets extra
    for (const entry of scoreMap.values()) {
      entry.score = (entry.overdueShifts * 10) + (entry.flaggedCount * 5) + (entry.urgentTickets * 4) + (entry.ticketCount * 2);
    }

    // Only include locations that actually have issues
    const problemIds = [...scoreMap.entries()].filter(([, e]) => e.score > 0).map(([id]) => id);
    if (problemIds.length === 0) return { locations: [], lookbackDays };

    // Fetch location details in one query
    const locations = await prisma.location.findMany({
      where: { id: { in: problemIds } },
      select: {
        id: true, name: true, type: true, qrCode: true,
        parent: { select: { id: true, name: true, type: true } }
      }
    });

    const locMap = new Map(locations.map(l => [l.id, l]));

    const ranked = problemIds.map(id => ({
      location: locMap.get(id),
      ...scoreMap.get(id)
    })).sort((a, b) => b.score - a.score);

    return { locations: ranked, lookbackDays };
  });

  // Room status board — visual overview of all scannable locations' cleaning status today
  // Excludes structural containers (BUILDING, FLOOR) — they don't get cleaned
  fastify.get('/analytics/room-status', async (request) => {
    const orgId = request.user.orgId;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const locations = await prisma.location.findMany({
      where: { orgId, isActive: true, type: { notIn: ['BUILDING', 'FLOOR'] } },
      select: {
        id: true, name: true, type: true,
        parent: { select: { name: true } },
        cleaningSchedules: { select: { shifts: true } },
        cleaningRecords: {
          where: { cleanedAt: { gte: todayStart, lte: todayEnd } },
          select: { shift: true, cleanedAt: true, supervisor: { select: { name: true } } },
          orderBy: { cleanedAt: 'desc' }
        }
      },
      orderBy: [{ type: 'asc' }, { name: 'asc' }]
    });

    return locations.map(loc => {
      const requiredShifts = loc.cleaningSchedules[0]?.shifts || [];
      const completedShifts = loc.cleaningRecords.map(r => r.shift);
      const allDone = requiredShifts.length > 0 && requiredShifts.every(s => completedShifts.includes(s));
      const partial = !allDone && completedShifts.length > 0;

      return {
        id: loc.id,
        name: loc.name,
        type: loc.type,
        parentName: loc.parent?.name || null,
        status: allDone ? 'CLEANED' : partial ? 'PARTIAL' : (requiredShifts.length > 0 ? 'NOT_CLEANED' : 'NO_SCHEDULE'),
        requiredShifts,
        completedShifts,
        lastCleanedAt: loc.cleaningRecords[0]?.cleanedAt || null,
        lastSupervisor: loc.cleaningRecords[0]?.supervisor?.name || null
      };
    });
  });

  // ── Comprehensive report for analytics page (period-based) ──
  // Accepts ?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Returns: summary, cleaning by shift, location breakdown, ticket stats, top workers, top supervisors
  fastify.get('/analytics/report', async (request, reply) => {
    const orgId = request.user.orgId;
    const { from, to } = request.query;

    // Default: today — validate date format
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (from && !dateRe.test(from)) return reply.code(400).send({ error: 'Invalid from date format. Use YYYY-MM-DD.' });
    if (to && !dateRe.test(to)) return reply.code(400).send({ error: 'Invalid to date format. Use YYYY-MM-DD.' });
    const periodStart = from ? new Date(from + 'T00:00:00') : (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
    const periodEnd = to ? new Date(to + 'T23:59:59.999') : (() => { const d = new Date(); d.setHours(23,59,59,999); return d; })();
    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) return reply.code(400).send({ error: 'Invalid date value.' });

    // Calculate days in period (minimum 1 for single-day)
    const periodMs = periodEnd - periodStart;
    const daysInPeriod = Math.max(1, Math.round(periodMs / (1000 * 60 * 60 * 24)));

    // C1 FIX: For single-day periods, previous period = the day before (not same day)
    const prevDuration = Math.max(periodMs, 86400000); // at least 1 day
    const prevEnd = new Date(periodStart.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - prevDuration + 1);
    prevStart.setHours(0, 0, 0, 0);

    // All parallel queries
    const [
      cleaningRecords,
      prevCleaningCount,
      prevFlaggedCount,
      tickets,
      prevTicketCount,
      locations,
      workers,
      supervisors,
      scheduleCount
    ] = await Promise.all([
      // Current period cleaning records
      prisma.cleaningRecord.findMany({
        where: { orgId, cleanedAt: { gte: periodStart, lte: periodEnd } },
        select: {
          id: true, shift: true, status: true, cleanedAt: true,
          locationId: true,
          location: { select: { id: true, name: true, type: true, parent: { select: { name: true } } } },
          supervisor: { select: { id: true, name: true } },
          workers: { select: { id: true, name: true } },
          images: { select: { id: true } }
        }
      }),
      // Previous period count for comparison
      prisma.cleaningRecord.count({
        where: { orgId, cleanedAt: { gte: prevStart, lte: prevEnd } }
      }),
      // Previous period flagged count
      prisma.cleaningRecord.count({
        where: { orgId, cleanedAt: { gte: prevStart, lte: prevEnd }, status: 'FLAGGED' }
      }),
      // Current period tickets
      prisma.ticket.findMany({
        where: { orgId, createdAt: { gte: periodStart, lte: periodEnd } },
        select: {
          id: true, title: true, priority: true, status: true, source: true,
          issueType: true, createdAt: true, resolvedAt: true,
          locationId: true,
          location: { select: { id: true, name: true, type: true, parent: { select: { name: true } } } }
        }
      }),
      // Previous period ticket count
      prisma.ticket.count({
        where: { orgId, createdAt: { gte: prevStart, lte: prevEnd } }
      }),
      // All active cleanable locations
      prisma.location.findMany({
        where: { orgId, isActive: true, type: { notIn: ['BUILDING', 'FLOOR'] } },
        select: {
          id: true, name: true, type: true,
          parent: { select: { name: true } },
          cleaningSchedules: { select: { shifts: true, frequency: true }, where: { isActive: true } }
        }
      }),
      // Active workers
      prisma.worker.findMany({
        where: { orgId, isActive: true },
        select: { id: true, name: true, employeeId: true }
      }),
      // Active supervisors
      prisma.user.findMany({
        where: { orgId, role: 'SUPERVISOR', isActive: true },
        select: { id: true, name: true }
      }),
      // Total active schedules
      prisma.cleaningSchedule.count({ where: { orgId, isActive: true } })
    ]);

    // ── Summary ──
    const totalRecords = cleaningRecords.length;
    const flaggedRecords = cleaningRecords.filter(r => r.status === 'FLAGGED').length;
    const totalImages = cleaningRecords.reduce((s, r) => s + r.images.length, 0);
    const changePercent = prevCleaningCount > 0 ? Math.round((totalRecords - prevCleaningCount) / prevCleaningCount * 100) : (totalRecords > 0 ? 100 : 0);
    const flaggedRate = totalRecords > 0 ? Math.round(flaggedRecords / totalRecords * 1000) / 10 : 0;
    const prevFlaggedRate = prevCleaningCount > 0 ? Math.round(prevFlaggedCount / prevCleaningCount * 1000) / 10 : 0;
    const avgPerDay = daysInPeriod > 0 ? Math.round(totalRecords / daysInPeriod * 10) / 10 : 0;

    // ── By Shift ──
    const byShift = {};
    for (const r of cleaningRecords) {
      byShift[r.shift] = (byShift[r.shift] || 0) + 1;
    }

    // ── Daily trend within period ──
    const dayMap = new Map();
    for (const r of cleaningRecords) {
      const day = r.cleanedAt.toISOString().split('T')[0];
      dayMap.set(day, (dayMap.get(day) || 0) + 1);
    }
    // Fill all days in range
    const trend = [];
    const d = new Date(periodStart);
    while (d <= periodEnd) {
      const key = d.toISOString().split('T')[0];
      trend.push({ date: key, count: dayMap.get(key) || 0 });
      d.setDate(d.getDate() + 1);
    }

    // ── Location breakdown ──
    const locRecordMap = new Map();
    for (const r of cleaningRecords) {
      if (!locRecordMap.has(r.locationId)) locRecordMap.set(r.locationId, []);
      locRecordMap.get(r.locationId).push(r.shift);
    }

    // Build ticket count map for O(1) lookup instead of O(locations×tickets)
    const ticketCountByLoc = new Map();
    for (const t of tickets) {
      ticketCountByLoc.set(t.locationId, (ticketCountByLoc.get(t.locationId) || 0) + 1);
    }

    // C2 FIX: Account for schedule frequency when calculating expected cleanings
    const locationBreakdown = locations.map(loc => {
      const schedule = loc.cleaningSchedules[0];
      const requiredShifts = schedule ? schedule.shifts : [];
      const frequency = schedule ? schedule.frequency : null;
      const expectedPerDay = requiredShifts.length;

      // Adjust expected count based on frequency
      let expectedTotal;
      if (expectedPerDay === 0) {
        expectedTotal = 0;
      } else if (frequency === 'WEEKLY') {
        expectedTotal = expectedPerDay * Math.max(1, Math.ceil(daysInPeriod / 7));
      } else {
        // DAILY (default) or other frequencies
        expectedTotal = expectedPerDay * daysInPeriod;
      }

      const actualRecords = locRecordMap.get(loc.id) || [];
      const completionRate = expectedTotal > 0 ? Math.min(100, Math.round(actualRecords.length / expectedTotal * 100)) : (actualRecords.length > 0 ? 100 : null);

      return {
        id: loc.id,
        name: loc.name,
        type: loc.type,
        parentName: loc.parent?.name || null,
        cleaned: actualRecords.length,
        expected: expectedTotal,
        completionRate,
        tickets: ticketCountByLoc.get(loc.id) || 0,
        hasSchedule: requiredShifts.length > 0
      };
    }).sort((a, b) => (a.completionRate ?? 999) - (b.completionRate ?? 999));

    // Overall completion rate across all scheduled locations
    const totalExpected = locationBreakdown.reduce((s, l) => s + l.expected, 0);
    const totalCleaned = locationBreakdown.reduce((s, l) => s + l.cleaned, 0);
    const overallCompletionRate = totalExpected > 0 ? Math.round(totalCleaned / totalExpected * 100) : null;

    // ── Ticket stats ──
    const ticketsByPriority = {};
    const ticketsByStatus = {};
    const ticketsBySource = { INTERNAL: 0, PUBLIC: 0 };
    const ticketsByIssueType = {};
    const ticketsByLocation = new Map();
    let resolvedCount = 0, resolutionTotal = 0;

    for (const t of tickets) {
      ticketsByPriority[t.priority] = (ticketsByPriority[t.priority] || 0) + 1;
      ticketsByStatus[t.status] = (ticketsByStatus[t.status] || 0) + 1;
      ticketsBySource[t.source || 'INTERNAL'] = (ticketsBySource[t.source || 'INTERNAL'] || 0) + 1;
      if (t.issueType) ticketsByIssueType[t.issueType] = (ticketsByIssueType[t.issueType] || 0) + 1;

      if (!ticketsByLocation.has(t.locationId)) {
        ticketsByLocation.set(t.locationId, { name: (t.location.parent?.name ? t.location.parent.name + ' → ' : '') + t.location.name, count: 0 });
      }
      ticketsByLocation.get(t.locationId).count++;

      if (t.resolvedAt) {
        resolvedCount++;
        resolutionTotal += (new Date(t.resolvedAt) - new Date(t.createdAt));
      }
    }
    const avgResolutionMs = resolvedCount > 0 ? Math.round(resolutionTotal / resolvedCount) : 0;

    const ticketLocations = [...ticketsByLocation.values()].sort((a, b) => b.count - a.count).slice(0, 10);

    // ── Worker performance (with quality metrics) ──
    const workerMap = new Map();
    for (const r of cleaningRecords) {
      for (const w of r.workers) {
        if (!workerMap.has(w.id)) workerMap.set(w.id, { id: w.id, name: w.name, records: 0, flagged: 0, images: 0 });
        const entry = workerMap.get(w.id);
        entry.records++;
        if (r.status === 'FLAGGED') entry.flagged++;
        entry.images += r.images.length;
      }
    }
    const topWorkers = [...workerMap.values()].map(w => ({
      ...w,
      flaggedRate: w.records > 0 ? Math.round(w.flagged / w.records * 1000) / 10 : 0,
      score: w.records - (w.flagged * 3)
    })).sort((a, b) => b.records - a.records).slice(0, 10);

    // ── Supervisor performance (with quality metrics) ──
    const supMap = new Map();
    for (const r of cleaningRecords) {
      if (r.supervisor) {
        if (!supMap.has(r.supervisor.id)) supMap.set(r.supervisor.id, { id: r.supervisor.id, name: r.supervisor.name, records: 0, flagged: 0 });
        const entry = supMap.get(r.supervisor.id);
        entry.records++;
        if (r.status === 'FLAGGED') entry.flagged++;
      }
    }
    const topSupervisors = [...supMap.values()].map(s => ({
      ...s,
      flaggedRate: s.records > 0 ? Math.round(s.flagged / s.records * 1000) / 10 : 0
    })).sort((a, b) => b.records - a.records).slice(0, 10);

    return {
      period: { from: periodStart.toISOString().split('T')[0], to: periodEnd.toISOString().split('T')[0], days: daysInPeriod },
      summary: {
        totalRecords,
        prevRecords: prevCleaningCount,
        changePercent,
        flaggedRecords,
        flaggedRate,
        prevFlaggedRate,
        totalImages,
        totalLocations: locations.length,
        scheduledLocations: scheduleCount,
        overallCompletionRate,
        avgPerDay,
        totalWorkers: workers.length,
        totalSupervisors: supervisors.length,
        totalTickets: tickets.length,
        prevTickets: prevTicketCount
      },
      byShift,
      trend,
      locationBreakdown,
      ticketStats: {
        total: tickets.length,
        byPriority: ticketsByPriority,
        byStatus: ticketsByStatus,
        bySource: ticketsBySource,
        byIssueType: ticketsByIssueType,
        topLocations: ticketLocations,
        resolved: resolvedCount,
        avgResolutionHours: avgResolutionMs > 0 ? Math.round(avgResolutionMs / (1000 * 60 * 60) * 10) / 10 : null
      },
      topWorkers,
      topSupervisors
    };
  });
}

module.exports = analyticsRoutes;
