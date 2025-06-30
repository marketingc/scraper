# SEO Crawler

A comprehensive Node.js web application for SEO analysis and website crawling.

## 🚀 Quick Start

### Local Development
```bash
npm install
npm start
```

Visit `http://localhost:3001` and log in with:
- Username: `admin`
- Password: `password`

### Production Deployment on Render.com
See [DEPLOY_RENDER.md](./DEPLOY_RENDER.md) for complete deployment instructions.

## ✨ Features

- **Comprehensive SEO Analysis**: Meta tags, headings, images, links, schema markup
- **Batch Processing**: Analyze thousands of URLs simultaneously  
- **URL Versioning**: Track changes and compare reports over time
- **Real-time Updates**: Live progress tracking with WebSockets
- **Export Capabilities**: CSV exports for reports and data
- **Responsive Interface**: Works on desktop and mobile devices

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: SQLite with WAL mode
- **Frontend**: EJS templating, Bootstrap 5
- **Real-time**: Socket.IO
- **Authentication**: bcrypt password hashing

## 📊 Use Cases

- **SEO Audits**: Comprehensive on-page SEO analysis
- **Site Monitoring**: Track SEO changes over time
- **Bulk Analysis**: Process large lists of URLs
- **Report Generation**: Detailed SEO recommendations

## 🔧 Environment Variables

Create a `.env` file based on `.env.example`:

```bash
NODE_ENV=production
PORT=3001
SESSION_SECRET=your-secure-session-secret
DATABASE_PATH=./data
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
```

## 📚 API Endpoints

- `GET /` - Dashboard
- `POST /analyze` - Analyze single URL
- `POST /api/bulk-submit` - Submit bulk URLs
- `GET /health` - Health check
- `GET /api/reports` - List reports

## 🔒 Security

- Secure session management
- Password hashing with bcrypt
- Input validation and sanitization
- HTTPS-ready configuration

## 📈 Performance

- SQLite with WAL mode for concurrency
- Dynamic crawling concurrency
- Efficient batch processing
- Memory-conscious operations

---

**Deploy to Render.com**: [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)