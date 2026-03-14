# Housekeeping Platform — Production Deployment Guide

Follow each step **in order**. Do NOT skip steps.

---

## STEP 1: Get Your GCP VM External IP

1. Go to **Google Cloud Console** → **Compute Engine** → **VM instances**
2. Find `kodspot-housekeeping-api`
3. Copy the **External IP** (e.g., `34.xxx.xxx.xxx`)
4. If there's no static external IP, reserve one:
   - Go to **VPC Network** → **IP addresses** → **Reserve External Static Address**
   - Name: `housekeeping-ip`, Region: `asia-south1`
   - Attach to `kodspot-housekeeping-api`

> **IMPORTANT**: You need a **static** external IP. If it's ephemeral, it changes on VM restart and your domain will break.

---

## STEP 2: Update DNS at Hostinger

Go to **Hostinger** → **Domains** → **kodspot.in** → **DNS / Nameservers**

**Delete** the existing A record (`@` → `2.57.91.91`) and create these:

| Type  | Name | Points to            | TTL  |
|-------|------|----------------------|------|
| A     | @    | `YOUR_GCP_EXTERNAL_IP` | 300 |
| CNAME | www  | kodspot.in           | 300  |

The CNAME for `www` already exists pointing to `kodspot.in` — that's correct, keep it.

> DNS propagation takes 5–30 minutes. You can check with: `nslookup kodspot.in`

---

## STEP 3: Open Firewall Ports on GCP

Go to **GCP Console** → **VPC Network** → **Firewall**

Ensure these rules exist (they may already be created):

| Name                 | Direction | Targets         | Ports       | Source         |
|----------------------|-----------|-----------------|-------------|----------------|
| allow-http           | Ingress   | All instances   | tcp:80      | 0.0.0.0/0     |
| allow-https          | Ingress   | All instances   | tcp:443     | 0.0.0.0/0     |
| allow-https-udp      | Ingress   | All instances   | udp:443     | 0.0.0.0/0     |

If missing, create them:
1. Click **Create Firewall Rule**
2. Name: `allow-http`, Direction: Ingress, Targets: All instances
3. Source IP ranges: `0.0.0.0/0`
4. Protocols: TCP, port `80`
5. Repeat for `allow-https` (TCP 443) and `allow-https-udp` (UDP 443)

---

## STEP 4: Set Up the VM

SSH into your VM (use the **SSH** button in GCP Console):

```bash
# Download and run the setup script
curl -fsSL https://raw.githubusercontent.com/kodspot/housekeeping-platform/main/infrastructure/setup-vm.sh -o setup-vm.sh
chmod +x setup-vm.sh
bash setup-vm.sh
```

**After the script completes, log out and log back in:**
```bash
exit
# (SSH back in)
```

Verify docker works:
```bash
docker ps
```

---

## STEP 5: Generate SSH Key for GitHub Actions

On the VM, generate a deploy key:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_deploy -N ""
```

Add the **public key** to the VM's authorized_keys:
```bash
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
```

Copy the **private key** — you'll need it for GitHub Secrets:
```bash
cat ~/.ssh/github_deploy
```

Copy the entire output including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`.

---

## STEP 6: Get Your Cloudflare R2 Credentials

Go to **Cloudflare Dashboard** → **R2 Object Storage**:

1. Your **Account ID** is in the URL: `dash.cloudflare.com/<ACCOUNT_ID>/...`
   - Or go to any domain → Overview → right sidebar shows "Account ID"
2. For API tokens: **R2** → **Manage R2 API Tokens** → **Create API Token**
   - Permission: **Object Read & Write**
   - Specify bucket: `kodspot-housekeeping`
   - Click **Create API Token**
   - Copy the **Access Key ID** and **Secret Access Key** (shown only once!)

---

## STEP 7: Add GitHub Secrets

Go to **GitHub** → **kodspot/housekeeping-platform** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add each secret one by one:

### VM Connection (3 secrets)
| Secret Name           | Value                                    |
|-----------------------|------------------------------------------|
| `GCP_HOST`            | Your VM's external IP (e.g., `34.x.x.x`) |
| `GCP_USERNAME`        | `kishan` (your SSH username on the VM)    |
| `GCP_SSH_PRIVATE_KEY` | The full private key from Step 5          |

### App Configuration (3 secrets)
| Secret Name      | Value                    |
|------------------|--------------------------|
| `APP_URL`        | `https://kodspot.in`     |
| `COOKIE_DOMAIN`  | `kodspot.in`             |
| `CORS_ORIGINS`   | `https://kodspot.in`     |

### Database (4 secrets)
| Secret Name    | Value |
|----------------|-------|
| `DB_USER`      | `housekeeping` |
| `DB_PASSWORD`  | `s9xFqZ8PEUcwrHDxAvoJu67k76k` |
| `DB_NAME`      | `housekeeping` |
| `DATABASE_URL` | `postgresql://housekeeping:s9xFqZ8PEUcwrHDxAvoJu67k76k@db:5432/housekeeping` |

> **NOTE**: The hostname in DATABASE_URL is `db` (Docker service name), NOT `localhost`.

### Auth Secrets (3 secrets)
| Secret Name     | Value |
|-----------------|-------|
| `JWT_SECRET`    | `6bd9020a56f2a131c96a73879e28965b35ff2a05923f87a6274d9dfa4ea148b2` |
| `COOKIE_SECRET` | `3f34267df11df601ee3698bdeee1f92f57b6400c9b21e2f340ec84702d917292` |
| `ADMIN_KEY`     | `a1a35d7228a115e775c762faebdba19d` |

### Cloudflare R2 (4 secrets)
| Secret Name           | Value                              |
|-----------------------|------------------------------------|
| `R2_ACCOUNT_ID`       | Your Cloudflare Account ID         |
| `R2_ACCESS_KEY_ID`    | From Step 6                        |
| `R2_SECRET_ACCESS_KEY`| From Step 6                        |
| `R2_BUCKET_NAME`      | `kodspot-housekeeping`             |

### Email / SES (optional — leave empty string if not using)
| Secret Name      | Value           |
|------------------|-----------------|
| `SES_SMTP_HOST`  | ` ` (space)     |
| `SES_SMTP_USER`  | ` ` (space)     |
| `SES_SMTP_PASS`  | ` ` (space)     |
| `SES_FROM_EMAIL` | ` ` (space)     |

**Total: 20 secrets**

---

## STEP 8: Push Code to GitHub

On your **local machine** (in VS Code terminal):

```powershell
cd "c:\KISHAN\MY SERVICE\menu-saas"

# Initialize git if not already done
git init
git branch -M main

# Add the remote
git remote add origin https://github.com/kodspot/housekeeping-platform.git

# Stage all files (respects .gitignore)
git add .

# Commit
git commit -m "Initial production deployment"

# Push
git push -u origin main
```

> This push will **automatically trigger** the GitHub Action to deploy to your VM.

---

## STEP 9: Monitor the Deployment

1. Go to **GitHub** → **kodspot/housekeeping-platform** → **Actions**
2. Watch the "Deploy to Production" workflow run
3. It should show green ✅ when complete

If it fails:
- Click on the failed run
- Read the error logs
- Most common issues: SSH key incorrect, VM firewall blocking, wrong secrets

---

## STEP 10: Verify

Once the GitHub Action is green:

1. Open `https://kodspot.in` in your browser
2. You should see the Housekeeping login page with HTTPS (lock icon)
3. Try `https://kodspot.in/admin-login` — should show admin login
4. Try `https://kodspot.in/health` — should return JSON with `status: "ok"`

---

## Troubleshooting

### "Connection refused" or site not loading
- Check GCP firewall rules (Step 3)
- Check DNS propagation: `nslookup kodspot.in`
- SSH into VM and check: `docker compose ps` and `docker compose logs`

### "Certificate error" / No HTTPS
- Caddy auto-provisions certs — wait 1-2 minutes after first deploy
- Check Caddy logs: `docker compose logs caddy`
- Ensure ports 80 and 443 are open in GCP firewall

### GitHub Action fails with SSH error
- Verify `GCP_HOST` is the correct external IP
- Verify `GCP_USERNAME` matches your VM username
- Verify the private key is complete (including BEGIN/END lines)

### API health check fails
- Check API logs: `docker compose logs api`
- Ensure DATABASE_URL uses `db` as hostname, not `localhost`
- Check if DB is healthy: `docker compose ps`

---

## Future Deployments

After this initial setup, every `git push` to `main` will automatically deploy. The workflow:

1. You push code to `main`
2. GitHub Actions SSHes into your VM
3. Pulls latest code
4. Writes fresh `.env` from secrets
5. Rebuilds containers
6. Runs health check
7. Done ✅
