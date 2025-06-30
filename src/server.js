const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const SEOCrawler = require('./crawler');
const SEOReporter = require('./reporter');
const Database = require('./database');
const { AuthManager, requireAuth, redirectIfLoggedIn } = require('./auth');
const QueueManager = require('./queue-manager');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Initialize database and auth
const db = new Database();
const auth = new AuthManager(db);

// Initialize queue manager with Socket.IO for real-time updates
const queueManager = new QueueManager(io);

// Configure session storage path
const sessionDbPath = process.env.DATABASE_PATH 
  ? process.env.DATABASE_PATH 
  : path.join(__dirname, '../data');

// Ensure session directory exists
if (!fs.existsSync(sessionDbPath)) {
  fs.mkdirSync(sessionDbPath, { recursive: true });
}

// Session configuration
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: sessionDbPath
  }),
  secret: process.env.SESSION_SECRET || 'seo-crawler-fallback-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction, // Use secure cookies in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint for Render.com
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Authentication routes
app.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('login', { error: null, message: null });
});

app.post('/login', redirectIfLoggedIn, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.render('login', { 
        error: 'Username and password are required', 
        message: null 
      });
    }

    const user = await auth.authenticateUser(username, password);
    if (user) {
      req.session.user = user;
      res.redirect('/');
    } else {
      res.render('login', { 
        error: 'Invalid username or password', 
        message: null 
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { 
      error: 'Login failed. Please try again.', 
      message: null 
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/login');
  });
});

// Protected routes
app.get('/', requireAuth, (req, res) => {
  res.render('dashboard', { user: req.session.user });
});

app.get('/analyze', requireAuth, (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.redirect('/');
  }
  res.render('analyze', { url: url, user: req.session.user });
});

app.get('/reports-overview', requireAuth, async (req, res) => {
  try {
    // Get pagination parameters with defaults optimized for performance
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const parsedLimit = parseInt(req.query.limit);
    const limit = Math.max(10, Math.min(isNaN(parsedLimit) ? 50 : parsedLimit, 1000)); // Clamp between 10 and 1000
    const offset = (page - 1) * limit;
    
    // Get filter parameters
    const filters = {
      search: req.query.search || '',
      crawlStatus: req.query.crawlStatus || '',
      scoreRange: req.query.scoreRange || '',
      httpStatus: req.query.httpStatus || '',
      dateRange: req.query.dateRange || '',
      issuesFilter: req.query.issuesFilter || '',
      pwaStatus: req.query.pwaStatus || '',
      imageIssues: req.query.imageIssues || '',
      schemaPresent: req.query.schemaPresent || ''
    };
    
    
    // Get total count for pagination (with filters)
    const totalCount = await db.getReportsCount(filters);
    const reports = await db.getAllReportsWithAnalysis(limit, offset, filters);
    
    // Calculate pagination info
    const totalPages = Math.max(0, Math.ceil(totalCount / Math.max(1, limit)));
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;
    
    res.render('reports-overview', { 
      reports, 
      user: req.session.user,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage,
        hasPrevPage,
        limit
      },
      filters
    });
  } catch (error) {
    console.error('Reports overview error:', error);
    res.status(500).render('error', { error: 'Failed to load reports overview' });
  }
});

app.get('/browse', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    
    let reports;
    if (search) {
      reports = await db.searchReports(search);
    } else {
      reports = await db.getAllReports(limit, offset);
    }
    
    res.render('browse', { reports, search, page, user: req.session.user });
  } catch (error) {
    res.status(500).render('error', { error: 'Failed to load reports' });
  }
});

app.get('/report/:id', requireAuth, async (req, res) => {
  try {
    const report = await db.getReport(req.params.id);
    if (!report) {
      return res.status(404).render('error', { error: 'Report not found' });
    }
    
    const reporter = new SEOReporter();
    const fullReport = reporter.generateDetailedReport(report.analysis_data);
    
    // Get version information for this URL
    let versionInfo = null;
    let allVersions = [];
    try {
      allVersions = await db.getUrlVersions(report.url);
      
      // Find current version info
      if (allVersions.length > 0) {
        // Try to match by report ID or find the version with matching data
        versionInfo = allVersions.find(v => {
          // Match by creation time (within 1 minute) or exact score match
          const timeDiff = Math.abs(new Date(v.created_at) - new Date(report.created_at));
          return timeDiff < 60000 || (v.seo_score === report.seo_score && v.title === report.title);
        }) || allVersions[0]; // Fallback to latest version
        
        // Add version context
        const currentIndex = allVersions.findIndex(v => v.id === versionInfo.id);
        versionInfo.previousVersion = currentIndex < allVersions.length - 1 ? allVersions[currentIndex + 1] : null;
        versionInfo.nextVersion = currentIndex > 0 ? allVersions[currentIndex - 1] : null;
        versionInfo.isLatest = currentIndex === 0;
        versionInfo.totalVersions = allVersions.length;
      }
    } catch (versionError) {
      console.warn('Failed to load version info:', versionError);
    }
    
    res.render('report', { 
      report: fullReport, 
      dbReport: report, 
      versionInfo,
      allVersions,
      user: req.session.user 
    });
  } catch (error) {
    res.status(500).render('error', { error: 'Failed to load report' });
  }
});

app.post('/analyze', requireAuth, async (req, res) => {
  try {
    const { url, retry, previousJobId } = req.body;
    
    console.log('Analyzing URL:', url, retry ? '(retry request)' : '(new request)');
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!url.match(/^https?:\/\//)) {
      return res.status(400).json({ error: 'URL must start with http:// or https://' });
    }

    // If this is a retry request, queue it for background processing
    if (retry) {
      console.log('Queueing URL for retry analysis:', url);
      
      try {
        // Create a single-URL batch for this retry
        const batchName = `Retry Analysis: ${url} (${new Date().toLocaleString()})`;
        const result = await queueManager.submitBulkUrls([url], req.session.user.id, batchName);
        
        // Get the job ID from the created batch
        const jobs = await db.getBatchJobs(result.batchId, 'pending');
        const jobId = jobs.length > 0 ? jobs[0].id : null;
        
        console.log(`URL queued for retry analysis with batch ID: ${result.batchId}, job ID: ${jobId}`);
        
        res.json({ 
          success: true, 
          jobId,
          batchId: result.batchId,
          message: 'URL queued for analysis. You will be redirected to track progress.'
        });
        return;
        
      } catch (queueError) {
        console.error('Error queueing URL for retry:', queueError);
        return res.status(500).json({ 
          error: 'Failed to queue URL for analysis: ' + queueError.message 
        });
      }
    }

    // Original immediate analysis for non-retry requests
    const crawler = new SEOCrawler();
    const reporter = new SEOReporter();

    console.log('Starting immediate analysis...');
    const analysis = await Promise.race([
      crawler.analyzePage(url),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Analysis timeout after 30 seconds')), 30000)
      )
    ]);
    
    console.log('Analysis completed, generating report...');
    const report = reporter.generateDetailedReport(analysis);

    console.log('Saving to database...');
    const versionResult = await db.saveVersionedReport(url, analysis, report, null, null);
    const reportId = versionResult.reportId || versionResult.versionId; // Prefer reportId, fallback to versionId
    
    console.log(`URL ${url} saved as version ${versionResult.version} ${versionResult.isNewUrl ? '(new URL)' : '(existing URL)'}`);
    
    console.log('Analysis complete, report ID:', reportId);

    res.json({ 
      success: true, 
      reportId,
      report 
    });

  } catch (error) {
    console.error('Analysis error:', error.message);
    res.status(500).json({ 
      error: error.message || 'Failed to analyze URL' 
    });
  }
});

app.get('/api/reports', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    
    let reports;
    if (search) {
      reports = await db.searchReports(search);
    } else {
      reports = await db.getAllReports(limit, offset);
    }
    
    res.json(reports);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

app.get('/api/report/:id', requireAuth, async (req, res) => {
  try {
    const report = await db.getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    const reporter = new SEOReporter();
    const fullReport = reporter.generateReport(report.analysis_data);
    
    res.json({ ...fullReport, created_at: report.created_at });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

app.delete('/api/report/:id', requireAuth, async (req, res) => {
  try {
    const reportId = req.params.id;
    
    // Check if report exists first
    const report = await db.getReport(reportId);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    // Delete the report
    const deleted = await db.deleteReport(reportId);
    if (deleted) {
      res.json({ success: true, message: 'Report deleted successfully' });
    } else {
      res.status(404).json({ error: 'Report not found' });
    }
  } catch (error) {
    console.error('Delete report error:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// Bulk delete all data endpoint
app.delete('/api/bulk-delete-all', requireAuth, async (req, res) => {
  try {
    const { confirmText } = req.body;
    
    // Safety check - user must type confirmation
    if (confirmText !== 'DELETE ALL DATA') {
      return res.status(400).json({ 
        error: 'Invalid confirmation. Please type "DELETE ALL DATA" exactly.' 
      });
    }
    
    console.log(`[BULK DELETE] User ${req.session.user.username} is deleting all data...`);
    
    // Perform bulk deletion
    const deletedCounts = await db.deleteAllData();
    
    console.log('[BULK DELETE] Deletion completed:', deletedCounts);
    
    res.json({ 
      success: true, 
      message: 'All data deleted successfully',
      deletedCounts: deletedCounts
    });
    
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: 'Failed to delete all data: ' + error.message });
  }
});

// Data counts endpoint for bulk delete modal
app.get('/api/data-counts', requireAuth, async (req, res) => {
  try {
    const counts = {
      reports: 0,
      versions: 0,
      masters: 0,
      batches: 0,
      queue: 0
    };
    
    // Get count of reports
    await new Promise((resolve) => {
      db.db.get('SELECT COUNT(*) as count FROM reports', (err, result) => {
        if (!err) counts.reports = result.count;
        resolve();
      });
    });
    
    // Get count of url_versions
    await new Promise((resolve) => {
      db.db.get('SELECT COUNT(*) as count FROM url_versions', (err, result) => {
        if (!err) counts.versions = result.count;
        resolve();
      });
    });
    
    // Get count of url_master
    await new Promise((resolve) => {
      db.db.get('SELECT COUNT(*) as count FROM url_master', (err, result) => {
        if (!err) counts.masters = result.count;
        resolve();
      });
    });
    
    // Get count of job_batches
    await new Promise((resolve) => {
      db.db.get('SELECT COUNT(*) as count FROM job_batches', (err, result) => {
        if (!err) counts.batches = result.count;
        resolve();
      });
    });
    
    // Get count of job_queue
    await new Promise((resolve) => {
      db.db.get('SELECT COUNT(*) as count FROM job_queue', (err, result) => {
        if (!err) counts.queue = result.count;
        resolve();
      });
    });
    
    res.json(counts);
  } catch (error) {
    console.error('Data counts error:', error);
    res.status(500).json({ error: 'Failed to get data counts' });
  }
});

// Bulk submission API endpoints
app.post('/api/bulk-submit', requireAuth, async (req, res) => {
  try {
    const { batchName, urls, options = {} } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'URLs array is required' });
    }
    
    if (urls.length > 20000) {
      return res.status(400).json({ error: 'Maximum 20,000 URLs allowed per batch' });
    }
    
    console.log(`Bulk submission: ${urls.length} URLs from user ${req.session.user.id}`);
    
    // For large batches, skip DNS validation to avoid timeout issues
    if (urls.length > 1000) {
      options.skipDnsValidation = true;
      console.log(`Large batch detected (${urls.length} URLs), skipping DNS validation for faster processing`);
    }
    
    // Submit URLs to queue
    const result = await queueManager.submitBulkUrls(
      urls, 
      req.session.user.id, 
      batchName, 
      options
    );
    
    res.json({ 
      success: true, 
      batchId: result.batchId,
      validationSummary: result.validationSummary,
      duplicatesRemoved: result.duplicatesRemoved,
      skippedUrls: result.skippedUrls,
      message: `Batch created with ${result.validationSummary.valid} valid URLs (${result.validationSummary.duplicates} duplicates removed, ${result.validationSummary.invalid} invalid URLs skipped)`
    });
    
  } catch (error) {
    console.error('Bulk submission error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to submit bulk URLs' 
    });
  }
});

// Get all batches
app.get('/api/batches', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const batches = await db.getAllBatches(req.session.user.id, limit, offset);
    res.json(batches);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch batches' });
  }
});

// Get specific batch details
app.get('/api/batch/:id', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const jobs = await db.getBatchJobs(batchId);
    const stats = await db.getBatchStats(batchId);
    
    res.json({
      batch,
      jobs,
      stats
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch batch details' });
  }
});

// Cancel batch
app.post('/api/batch/:id/cancel', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await queueManager.cancelBatch(batchId);
    res.json({ success: true, message: 'Batch cancelled' });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel batch' });
  }
});

// Retry failed jobs in batch
app.post('/api/batch/:id/retry', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const retriedCount = await queueManager.retryBatch(batchId);
    res.json({ 
      success: true, 
      message: `${retriedCount} failed jobs restarted` 
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to retry batch' });
  }
});

// Pause batch processing
app.post('/api/batch/:id/pause', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const pausedCount = await queueManager.pauseBatch(batchId);
    res.json({ 
      success: true, 
      message: `Batch paused - ${pausedCount} jobs paused` 
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to pause batch' });
  }
});

// Resume batch processing
app.post('/api/batch/:id/resume', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const resumedCount = await queueManager.resumeBatch(batchId);
    res.json({ 
      success: true, 
      message: `Batch resumed - ${resumedCount} jobs resumed` 
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to resume batch' });
  }
});

// Export batch results
app.get('/api/batch/:id/export', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Get all jobs with their reports
    const jobs = await db.getBatchJobsWithReports(batchId);
    
    // Format data for export
    const exportData = jobs.map(job => ({
      url: job.url,
      status: job.status,
      error_message: job.error_message || '',
      seo_score: job.seo_score || 'N/A',
      title: job.title || 'N/A',
      description: job.description || 'N/A',
      created_at: job.created_at,
      completed_at: job.updated_at
    }));
    
    // Set headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="batch-${batchId}-export.csv"`);
    
    // Generate CSV content
    const csvHeaders = 'URL,Status,Error Message,SEO Score,Title,Description,Created At,Completed At\n';
    const csvRows = exportData.map(row => 
      [
        `"${row.url}"`,
        row.status,
        `"${row.error_message.replace(/"/g, '""')}"`,
        row.seo_score,
        `"${row.title.replace(/"/g, '""')}"`,
        `"${row.description.replace(/"/g, '""')}"`,
        row.created_at,
        row.completed_at || ''
      ].join(',')
    ).join('\n');
    
    res.send(csvHeaders + csvRows);
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export batch data' });
  }
});

// Retry only failed jobs in batch
app.post('/api/batch/:id/retry-failed', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const retriedCount = await queueManager.retryBatch(batchId);
    res.json({ 
      success: true, 
      message: `${retriedCount} failed jobs queued for retry` 
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to retry failed jobs' });
  }
});

// Queue status endpoint
app.get('/api/queue/status', requireAuth, (req, res) => {
  const status = queueManager.getQueueStatus();
  res.json(status);
});

// Performance metrics endpoint
app.get('/api/performance', requireAuth, (req, res) => {
  try {
    const performanceReport = queueManager.getPerformanceReport();
    res.json(performanceReport);
  } catch (error) {
    console.error('Error getting performance report:', error);
    res.status(500).json({ error: 'Failed to get performance metrics' });
  }
});

// URL Versioning API endpoints

// Get all versions for a URL
app.get('/api/url/versions', requireAuth, async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    const versions = await db.getUrlVersions(url);
    res.json({ url, versions });
    
  } catch (error) {
    console.error('Get URL versions error:', error);
    res.status(500).json({ error: 'Failed to fetch URL versions' });
  }
});

// Get specific version of a URL
app.get('/api/url/version', requireAuth, async (req, res) => {
  try {
    const { url, version } = req.query;
    
    if (!url || !version) {
      return res.status(400).json({ error: 'URL and version parameters are required' });
    }
    
    const versionData = await db.getUrlVersion(url, parseInt(version));
    
    if (!versionData) {
      return res.status(404).json({ error: 'Version not found' });
    }
    
    res.json(versionData);
    
  } catch (error) {
    console.error('Get URL version error:', error);
    res.status(500).json({ error: 'Failed to fetch URL version' });
  }
});

// Compare two versions of a URL
app.get('/api/url/compare', requireAuth, async (req, res) => {
  try {
    const { url, v1, v2 } = req.query;
    
    if (!url || !v1 || !v2) {
      return res.status(400).json({ error: 'URL, v1, and v2 parameters are required' });
    }
    
    const version1 = await db.getUrlVersion(url, parseInt(v1));
    const version2 = await db.getUrlVersion(url, parseInt(v2));
    
    if (!version1 || !version2) {
      return res.status(404).json({ error: 'One or both versions not found' });
    }
    
    // Calculate differences
    const comparison = {
      url,
      version1: {
        number: version1.version_number,
        date: version1.created_at,
        title: version1.title,
        description: version1.description,
        seo_score: version1.seo_score,
        batch_name: version1.batch_name
      },
      version2: {
        number: version2.version_number,
        date: version2.created_at,
        title: version2.title,
        description: version2.description,
        seo_score: version2.seo_score,
        batch_name: version2.batch_name
      },
      changes: {
        title_changed: version1.title !== version2.title,
        description_changed: version1.description !== version2.description,
        score_changed: version1.seo_score !== version2.seo_score,
        score_difference: version2.seo_score - version1.seo_score
      }
    };
    
    res.json(comparison);
    
  } catch (error) {
    console.error('Compare URL versions error:', error);
    res.status(500).json({ error: 'Failed to compare URL versions' });
  }
});

// Get all URLs with version info
app.get('/api/urls-overview', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    const urls = await db.getAllUrlsWithVersions(limit, offset);
    res.json(urls);
    
  } catch (error) {
    console.error('Get URLs overview error:', error);
    res.status(500).json({ error: 'Failed to fetch URLs overview' });
  }
});

// API endpoint for AJAX-based reports loading
app.get('/api/reports-overview', requireAuth, async (req, res) => {
  try {
    // Get pagination parameters with defaults optimized for performance
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const parsedLimit = parseInt(req.query.limit);
    const limit = Math.max(10, Math.min(isNaN(parsedLimit) ? 50 : parsedLimit, 1000)); // Clamp between 10 and 1000
    const offset = (page - 1) * limit;
    
    // Get filter parameters
    const filters = {
      search: req.query.search || '',
      crawlStatus: req.query.crawlStatus || '',
      scoreRange: req.query.scoreRange || '',
      httpStatus: req.query.httpStatus || '',
      dateRange: req.query.dateRange || '',
      issuesFilter: req.query.issuesFilter || '',
      pwaStatus: req.query.pwaStatus || '',
      imageIssues: req.query.imageIssues || '',
      schemaPresent: req.query.schemaPresent || ''
    };
    
    // Get total count for pagination (with filters)
    const totalCount = await db.getReportsCount(filters);
    const reports = await db.getAllReportsWithAnalysis(limit, offset, filters);
    
    // Calculate pagination info
    const totalPages = Math.max(0, Math.ceil(totalCount / Math.max(1, limit)));
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;
    
    res.json({
      reports,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage,
        hasPrevPage,
        limit
      },
      filters,
      performance: {
        query_time: Date.now(), // Could be used to track query performance
        cached: false // Placeholder for future caching implementation
      }
    });
    
  } catch (error) {
    console.error('API reports overview error:', error);
    res.status(500).json({ error: 'Failed to fetch reports overview' });
  }
});

// Batch monitoring pages
app.get('/batch/:id', requireAuth, async (req, res) => {
  try {
    const batchId = req.params.id;
    const batch = await db.getBatch(batchId);
    
    if (!batch) {
      return res.status(404).render('error', { error: 'Batch not found' });
    }
    
    // Check ownership
    if (batch.created_by !== req.session.user.id) {
      return res.status(403).render('error', { error: 'Access denied' });
    }
    
    res.render('batch-monitor', { 
      batch, 
      batchId,
      user: req.session.user 
    });
  } catch (error) {
    res.status(500).render('error', { error: 'Failed to load batch' });
  }
});

// Batches overview page
app.get('/batches', requireAuth, async (req, res) => {
  try {
    const batches = await db.getAllBatches(req.session.user.id, 50, 0);
    res.render('batches-overview', { 
      batches, 
      user: req.session.user 
    });
  } catch (error) {
    res.status(500).render('error', { error: 'Failed to load batches' });
  }
});

// URL Versions overview page
app.get('/url-versions', requireAuth, async (req, res) => {
  try {
    // Get pagination parameters from query string with proper validation
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const parsedLimit = parseInt(req.query.limit);
    const limit = Math.max(1, Math.min(isNaN(parsedLimit) ? 50 : parsedLimit, 10000)); // Clamp between 1 and 10000
    const offset = (page - 1) * limit;
    
    // Get filter parameters
    const filters = {
      search: req.query.search || '',
      scoreRange: req.query.scoreRange || '',
      versionRange: req.query.versionRange || '',
      crawlFrequency: req.query.crawlFrequency || '',
      dateRange: req.query.dateRange || '',
      batchFilter: req.query.batchFilter || ''
    };
    
    // Get total count for pagination (with filters)
    const totalCount = await db.getTotalUniqueUrlsCount(filters);
    const urls = await db.getAllUrlsWithVersions(limit, offset, filters);
    
    // Calculate pagination info with division by zero protection
    const totalPages = Math.max(0, Math.ceil(totalCount / Math.max(1, limit)));
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;
    
    res.render('url-versions-overview', { 
      urls, 
      user: req.session.user,
      filters,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage,
        hasPrevPage,
        limit
      }
    });
  } catch (error) {
    console.error('Error loading URL versions:', error);
    res.status(500).render('error', { error: 'Failed to load URL versions' });
  }
});

// URL Version history page
app.get('/url-history', requireAuth, async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).render('error', { error: 'URL parameter is required' });
    }
    
    const versions = await db.getUrlVersions(url);
    
    if (versions.length === 0) {
      return res.status(404).render('error', { error: 'No versions found for this URL' });
    }
    
    res.render('url-history', { 
      url, 
      versions, 
      user: req.session.user 
    });
  } catch (error) {
    res.status(500).render('error', { error: 'Failed to load URL history' });
  }
});

// URL Version comparison page
app.get('/url-compare', requireAuth, async (req, res) => {
  try {
    const { url, v1, v2 } = req.query;
    
    if (!url || !v1 || !v2) {
      return res.status(400).render('error', { error: 'URL, v1, and v2 parameters are required' });
    }
    
    const version1 = await db.getUrlVersion(url, parseInt(v1));
    const version2 = await db.getUrlVersion(url, parseInt(v2));
    
    if (!version1 || !version2) {
      return res.status(404).render('error', { error: 'One or both versions not found' });
    }
    
    res.render('url-compare', { 
      url,
      version1, 
      version2, 
      user: req.session.user 
    });
  } catch (error) {
    console.error('Error in /url-compare route:', error);
    res.status(500).render('error', { error: 'Failed to load version comparison: ' + error.message });
  }
});

// SEO Algorithm Documentation page
app.get('/seo-algorithm', requireAuth, (req, res) => {
  res.render('seo-algorithm', { 
    user: req.session.user 
  });
});

// SEO Scoring Breakdown page
app.get('/seo-scoring-breakdown', requireAuth, (req, res) => {
  res.render('seo-scoring-breakdown', { 
    user: req.session.user 
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected to real-time updates');
  
  socket.on('join-batch', (batchId) => {
    socket.join(`batch-${batchId}`);
    console.log(`Client joined batch ${batchId} room`);
  });
  
  socket.on('leave-batch', (batchId) => {
    socket.leave(`batch-${batchId}`);
    console.log(`Client left batch ${batchId} room`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await queueManager.shutdown();
  db.close();
  process.exit(0);
});

// Production setup function
async function setupProduction() {
  if (!isProduction) return;
  
  console.log('🔧 Running production setup...');
  
  try {
    // Wait for database initialization
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 30;
      
      const checkTables = () => {
        attempts++;
        db.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='url_versions'", (err, row) => {
          if (err) {
            if (attempts >= maxAttempts) {
              reject(new Error('Database initialization timeout'));
            } else {
              setTimeout(checkTables, 1000);
            }
          } else if (row) {
            resolve();
          } else {
            console.log(`⏳ Waiting for database initialization... (${attempts}/${maxAttempts})`);
            if (attempts >= maxAttempts) {
              reject(new Error('Database tables not created within timeout'));
            } else {
              setTimeout(checkTables, 1000);
            }
          }
        });
      };
      
      checkTables();
    });
    
    // Create admin user if environment variables are provided
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (adminUsername && adminPassword) {
      try {
        const existingUser = await auth.getUserByUsername(adminUsername);
        
        if (!existingUser) {
          await auth.createUser(adminUsername, adminPassword);
          console.log(`✅ Admin user '${adminUsername}' created successfully`);
        } else {
          console.log(`ℹ️  Admin user '${adminUsername}' already exists`);
        }
      } catch (error) {
        console.error('⚠️  Error creating admin user:', error.message);
      }
    }
    
    console.log('✅ Production setup completed');
  } catch (error) {
    console.error('❌ Production setup failed:', error.message);
  }
}

// Start server with production setup
async function startServer() {
  await setupProduction();
  
  server.listen(port, () => {
    console.log(`🚀 SEO Crawler Web Interface running on port ${port}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`❤️  Health check available at: /health`);
  });
}

startServer();

module.exports = app;