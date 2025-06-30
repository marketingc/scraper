# SEO Crawler - Render.com Deployment Guide

## 🚀 Quick Deploy to Render.com

### Prerequisites
- A [Render.com](https://render.com) account
- Your SEO Crawler code in a Git repository (GitHub, GitLab, or Bitbucket)

### 1. Automatic Deployment (Recommended)

The project includes a `render.yaml` file for automatic deployment:

1. **Connect your repository** to Render.com
2. **Select "Web Service"** from your dashboard
3. **Choose your repository** containing the SEO Crawler code
4. Render will **automatically detect** the `render.yaml` configuration
5. **Review the settings** and click "Create Web Service"

### 2. Manual Deployment

If you prefer manual setup:

1. **Create a new Web Service** on Render.com
2. **Connect your repository**
3. **Configure the following settings**:

   | Setting | Value |
   |---------|-------|
   | **Environment** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Node Version** | `18` or higher |

### 3. Environment Variables

Set these environment variables in your Render service:

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `production` | Sets production mode |
| `SESSION_SECRET` | `[Auto-generated]` | Secure session secret (let Render generate) |
| `DATABASE_PATH` | `/opt/render/project/src/data` | Database storage path |
| `ADMIN_USERNAME` | `admin` | Initial admin username (optional) |
| `ADMIN_PASSWORD` | `your-secure-password` | Initial admin password (optional) |

### 4. Persistent Storage

The application requires persistent storage for the SQLite database:

1. **Add a Disk** to your service:
   - **Name**: `seo-crawler-data`
   - **Mount Path**: `/opt/render/project/src/data`
   - **Size**: `1GB` (or as needed)

## 🔧 Configuration Details

### Database Configuration
- **Type**: SQLite with persistent disk storage
- **Location**: `/opt/render/project/src/data/seo_reports.db`
- **Features**: WAL mode for better concurrency
- **Automatic**: Database and tables created on first run

### Security Features
- ✅ Secure session cookies in production
- ✅ Environment-based session secrets
- ✅ HTTPS-ready configuration
- ✅ Secure password hashing with bcrypt

### Health Monitoring
- **Health Check URL**: `/health`
- **Response**: JSON with status, timestamp, version
- **Automatic**: Render will monitor this endpoint

## 📋 Post-Deployment Steps

### 1. First-Time Setup
After deployment, your app will:
- ✅ Automatically create the database
- ✅ Set up all required tables
- ✅ Create initial admin user (if credentials provided)

### 2. Access Your Application
1. **Find your app URL** in the Render dashboard
2. **Visit the URL** in your browser
3. **Log in** with your admin credentials:
   - Username: `admin` (or your custom username)
   - Password: Your configured password

### 3. Change Default Password
🚨 **Important**: If you used default credentials, change them immediately:
1. Log into the application
2. Go to user settings
3. Change the password to something secure

## 🔍 Monitoring & Logs

### Viewing Logs
1. Go to your **Render dashboard**
2. Select your **SEO Crawler service**
3. Click on **"Logs"** tab
4. Monitor startup messages and any errors

### Key Log Messages
```
✅ Database path: /opt/render/project/src/data/seo_reports.db
✅ Admin user 'admin' created successfully
✅ SEO Crawler Web Interface running on port 10000
✅ Environment: production
✅ Health check available at: /health
```

## 🛠️ Troubleshooting

### Common Issues

#### 1. App Won't Start
**Problem**: Service fails to start
**Solution**: 
- Check logs for error messages
- Verify all environment variables are set
- Ensure disk is properly mounted

#### 2. Database Errors
**Problem**: SQLite database issues
**Solution**:
- Check disk mount path is correct
- Verify write permissions
- Check available disk space

#### 3. Login Issues
**Problem**: Can't log in with admin credentials
**Solution**:
- Check environment variables are set correctly
- Review setup logs for admin user creation
- Try recreating the admin user

#### 4. Performance Issues
**Problem**: Slow response times
**Solution**:
- Upgrade to a higher Render plan
- Monitor resource usage in dashboard
- Check for concurrent crawling limits

### Getting Help
- **Check the logs** first in Render dashboard
- **Visit health endpoint**: `your-app-url.render.com/health`
- **Review environment variables** in service settings

## 🔄 Updates & Maintenance

### Automatic Updates
- **Push to your repository** main/master branch
- **Render automatically deploys** new versions
- **Zero-downtime deployment** for most updates

### Manual Restart
If needed, restart your service:
1. Go to Render dashboard
2. Select your service
3. Click "Manual Deploy" → "Deploy Latest Commit"

### Database Backups
- Consider implementing regular database exports
- Use the built-in export features in the application
- Download important reports before major updates

## 📈 Scaling Considerations

### Resource Limits
- **Starter Plan**: Good for light usage
- **Standard Plan**: Recommended for regular use
- **Pro Plan**: For heavy crawling workloads

### Performance Tips
1. **Monitor database size** - SQLite performs well up to several GB
2. **Batch operations** - Use bulk URL submission for efficiency
3. **Resource monitoring** - Watch CPU and memory usage
4. **Disk space** - Monitor and increase as needed

## 🎯 Production Best Practices

### Security
- ✅ Use strong, unique SESSION_SECRET
- ✅ Change default admin password immediately
- ✅ Regularly update dependencies
- ✅ Monitor access logs

### Performance
- ✅ Regular database maintenance
- ✅ Monitor resource usage
- ✅ Use appropriate Render plan for your usage
- ✅ Clean up old reports periodically

### Reliability
- ✅ Monitor health check endpoint
- ✅ Set up alerts in Render dashboard
- ✅ Regular application updates
- ✅ Database backups for important data

---

## 🎉 You're Ready!

Your SEO Crawler is now running on Render.com with:
- ✅ Production-grade configuration
- ✅ Persistent data storage
- ✅ Automatic health monitoring
- ✅ Secure authentication
- ✅ Scalable architecture

**Happy crawling!** 🕷️📊