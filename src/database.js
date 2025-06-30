const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class Database {
  constructor() {
    // Use environment variable for database path in production
    const dbPath = process.env.DATABASE_PATH 
      ? path.join(process.env.DATABASE_PATH, 'seo_reports.db')
      : path.join(__dirname, '../data/seo_reports.db');
    
    // Ensure data directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    console.log(`Database path: ${dbPath}`);
    this.db = new sqlite3.Database(dbPath);
    
    // Configure SQLite for better concurrency
    this.db.configure('busyTimeout', 10000); // 10 second timeout
    this.db.run('PRAGMA journal_mode = WAL'); // Write-Ahead Logging
    this.db.run('PRAGMA synchronous = NORMAL'); // Faster but still safe
    this.db.run('PRAGMA cache_size = 10000'); // Larger cache
    
    this.init();
  }

  init() {
    this.db.serialize(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL,
          title TEXT,
          description TEXT,
          seo_score INTEGER,
          analysis_data TEXT,
          recommendations TEXT,
          batch_id INTEGER,
          job_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (batch_id) REFERENCES job_batches (id),
          FOREIGN KEY (job_id) REFERENCES job_queue (id)
        )
      `);
      
      this.db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          email TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_login DATETIME,
          is_active BOOLEAN DEFAULT 1
        )
      `);
      
      this.db.run(`
        CREATE TABLE IF NOT EXISTS job_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          total_urls INTEGER,
          completed_urls INTEGER DEFAULT 0,
          failed_urls INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          created_by INTEGER,
          concurrency INTEGER DEFAULT 3,
          delay_ms INTEGER DEFAULT 1000,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          started_at DATETIME,
          completed_at DATETIME,
          FOREIGN KEY (created_by) REFERENCES users (id)
        )
      `);
      
      this.db.run(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER,
          url TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          priority INTEGER DEFAULT 0,
          attempts INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 3,
          error_message TEXT,
          report_id INTEGER,
          next_retry_at DATETIME,
          retry_delay_ms INTEGER DEFAULT 10000,
          base_timeout_ms INTEGER DEFAULT 10000,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          started_at DATETIME,
          completed_at DATETIME,
          FOREIGN KEY (batch_id) REFERENCES job_batches (id),
          FOREIGN KEY (report_id) REFERENCES reports (id)
        )
      `);
      
      // URL versioning tables
      this.db.run(`
        CREATE TABLE IF NOT EXISTS url_master (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT UNIQUE NOT NULL,
          current_version INTEGER DEFAULT 1,
          first_crawled DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_crawled DATETIME DEFAULT CURRENT_TIMESTAMP,
          total_crawls INTEGER DEFAULT 1
        )
      `);

      // Create indexes for better performance with large datasets
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at DESC)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_reports_url ON reports (url)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_reports_seo_score ON reports (seo_score)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_reports_batch_id ON reports (batch_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_url_master_url ON url_master (url)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_url_master_last_crawled ON url_master (last_crawled DESC)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_url_versions_master_id ON url_versions (url_master_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_url_versions_created_at ON url_versions (created_at DESC)`);
      
      // Add retry functionality fields to existing job_queue table (migration)
      this.db.run(`ALTER TABLE job_queue ADD COLUMN next_retry_at DATETIME`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding next_retry_at column:', err.message);
        }
      });
      
      this.db.run(`ALTER TABLE job_queue ADD COLUMN retry_delay_ms INTEGER DEFAULT 10000`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding retry_delay_ms column:', err.message);
        }
      });
      
      this.db.run(`ALTER TABLE job_queue ADD COLUMN base_timeout_ms INTEGER DEFAULT 10000`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
          console.error('Error adding base_timeout_ms column:', err.message);
        }
      });
      
      this.db.run(`
        CREATE TABLE IF NOT EXISTS url_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url_master_id INTEGER NOT NULL,
          version_number INTEGER NOT NULL,
          title TEXT,
          description TEXT,
          seo_score INTEGER,
          analysis_data TEXT,
          recommendations TEXT,
          batch_id INTEGER,
          job_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (url_master_id) REFERENCES url_master (id),
          FOREIGN KEY (batch_id) REFERENCES job_batches (id),
          FOREIGN KEY (job_id) REFERENCES job_queue (id),
          UNIQUE(url_master_id, version_number)
        )
      `);
    });
  }

  saveReport(url, analysisData, report) {
    // Legacy method - now redirects to versioned system
    return this.saveVersionedReport(url, analysisData, report, null, null)
      .then(result => result.versionId);
  }

  getReport(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM reports WHERE id = ?',
        [id],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            if (row) {
              row.analysis_data = JSON.parse(row.analysis_data);
              row.recommendations = JSON.parse(row.recommendations);
            }
            resolve(row);
          }
        }
      );
    });
  }

  getAllReports(limit = 50, offset = 0) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT 
          r.id, 
          r.url, 
          r.title, 
          r.seo_score, 
          r.created_at,
          MIN(uv.version_number) as version_number,
          um.current_version,
          um.total_crawls
        FROM reports r
        LEFT JOIN url_master um ON r.url = um.url
        LEFT JOIN url_versions uv ON (
          um.id = uv.url_master_id 
          AND ABS(strftime('%s', r.created_at) - strftime('%s', uv.created_at)) <= 5
        )
        GROUP BY r.id, r.url, r.title, r.seo_score, r.created_at, um.current_version, um.total_crawls
        ORDER BY r.created_at DESC 
        LIMIT ? OFFSET ?`,
        [limit, offset],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  getAllReportsWithAnalysis(limit = 50, offset = 0, filters = {}) {
    return new Promise((resolve, reject) => {
      // Build WHERE clause based on filters
      const whereConditions = [];
      const params = [];
      
      if (filters.search) {
        whereConditions.push('(LOWER(r.url) LIKE ? OR LOWER(r.title) LIKE ?)');
        params.push(`%${filters.search.toLowerCase()}%`, `%${filters.search.toLowerCase()}%`);
      }
      
      if (filters.crawlStatus) {
        if (filters.crawlStatus === 'failed') {
          whereConditions.push(`(
            (r.seo_score = 0 AND r.title = 'Failed to crawl') OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') = 0 OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.statusCategory') = 'failed' OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 400 OR
            JSON_EXTRACT(r.analysis_data, '$.error') IS NOT NULL OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.details.crawlFailed') = 1
          )`);
        } else if (filters.crawlStatus === 'success') {
          whereConditions.push(`NOT (
            (r.seo_score = 0 AND r.title = 'Failed to crawl') OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') = 0 OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.statusCategory') = 'failed' OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 400 OR
            JSON_EXTRACT(r.analysis_data, '$.error') IS NOT NULL OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.details.crawlFailed') = 1
          )`);
        }
      }
      
      if (filters.scoreRange) {
        switch (filters.scoreRange) {
          case 'excellent':
            whereConditions.push('r.seo_score >= 80');
            break;
          case 'good':
            whereConditions.push('r.seo_score >= 60 AND r.seo_score < 80');
            break;
          case 'fair':
            whereConditions.push('r.seo_score >= 40 AND r.seo_score < 60');
            break;
          case 'poor':
            whereConditions.push('r.seo_score < 40');
            break;
        }
      }
      
      if (filters.httpStatus) {
        switch (filters.httpStatus) {
          case '2xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 200 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 300");
            break;
          case '3xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 300 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 400");
            break;
          case '4xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 400 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 500");
            break;
          case '5xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 500 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 600");
            break;
        }
      }
      
      if (filters.dateRange) {
        const now = new Date();
        switch (filters.dateRange) {
          case 'today':
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            whereConditions.push('r.created_at >= ?');
            params.push(todayStart.toISOString());
            break;
          case 'week':
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            whereConditions.push('r.created_at >= ?');
            params.push(weekAgo.toISOString());
            break;
          case 'month':
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            whereConditions.push('r.created_at >= ?');
            params.push(monthAgo.toISOString());
            break;
          case '3months':
            const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            whereConditions.push('r.created_at >= ?');
            params.push(threeMonthsAgo.toISOString());
            break;
        }
      }
      
      if (filters.schemaPresent) {
        switch (filters.schemaPresent) {
          case 'none':
            // Pages with no schema (0 schemas)
            whereConditions.push(`(
              (JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') IS NULL OR JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.microdata') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.rdfa') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')) = 0)
            )`);
            break;
          case 'few':
            // Pages with few schemas (1-2 schemas)
            whereConditions.push(`(
              COALESCE(JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas'), 
                (COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')), 0))
              ) BETWEEN 1 AND 2
            )`);
            break;
          case 'some':
            // Pages with some schemas (3-5 schemas)
            whereConditions.push(`(
              COALESCE(JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas'), 
                (COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')), 0))
              ) BETWEEN 3 AND 5
            )`);
            break;
          case 'many':
            // Pages with many schemas (6+ schemas)
            whereConditions.push(`(
              COALESCE(JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas'), 
                (COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')), 0))
              ) >= 6
            )`);
            break;
          case 'yes':
            // Backward compatibility: Pages with any schema
            whereConditions.push(`(
              JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') > 0 OR
              (JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd') IS NOT NULL AND JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')) > 0) OR
              (JSON_EXTRACT(r.analysis_data, '$.schema.microdata') IS NOT NULL AND JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')) > 0) OR
              (JSON_EXTRACT(r.analysis_data, '$.schema.rdfa') IS NOT NULL AND JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')) > 0)
            )`);
            break;
          case 'no':
            // Backward compatibility: Pages without schema
            whereConditions.push(`(
              (JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') IS NULL OR JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.microdata') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.rdfa') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')) = 0)
            )`);
            break;
        }
      }
      
      if (filters.pwaStatus) {
        switch (filters.pwaStatus) {
          case 'has':
            // Pages with PWA manifest
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.pwa.hasManifest') = 1");
            break;
          case 'none':
            // Pages without PWA manifest
            whereConditions.push("(JSON_EXTRACT(r.analysis_data, '$.pwa.hasManifest') IS NULL OR JSON_EXTRACT(r.analysis_data, '$.pwa.hasManifest') = 0)");
            break;
        }
      }
      
      
      if (filters.imageIssues) {
        switch (filters.imageIssues) {
          case 'noalt':
            // Pages with images that have missing alt text (hasAlt = false or isEmpty = true)
            whereConditions.push(`JSON_EXTRACT(r.analysis_data, '$.images') IS NOT NULL AND (
              r.analysis_data LIKE '%"hasAlt":false%' OR
              r.analysis_data LIKE '%"isEmpty":true%'
            )`);
            break;
          case 'goodalt':
            // Pages where all images have alt text (no hasAlt=false or isEmpty=true)
            whereConditions.push(`JSON_EXTRACT(r.analysis_data, '$.images') IS NOT NULL AND 
              r.analysis_data NOT LIKE '%"hasAlt":false%' AND
              r.analysis_data NOT LIKE '%"isEmpty":true%'`);
            break;
        }
      }
      
      if (filters.issuesFilter) {
        switch (filters.issuesFilter) {
          case 'noissues':
            // Pages with no critical or warning recommendations
            whereConditions.push(`(
              r.recommendations NOT LIKE '%"type":"critical"%' AND
              r.recommendations NOT LIKE '%"type":"warning"%'
            )`);
            break;
          case 'hasissues':
            // Pages with any critical or warning recommendations
            whereConditions.push(`(
              r.recommendations LIKE '%"type":"critical"%' OR
              r.recommendations LIKE '%"type":"warning"%'
            )`);
            break;
          case 'critical':
            // Pages with critical recommendations only
            whereConditions.push('r.recommendations LIKE \'%"type":"critical"%\'');
            break;
        }
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      
      // Add limit and offset parameters
      params.push(limit, offset);
      
      const query = `SELECT 
          r.id, 
          r.url, 
          r.title, 
          r.seo_score, 
          r.analysis_data, 
          r.recommendations, 
          r.created_at,
          r.batch_id,
          b.name as batch_name,
          CASE 
            WHEN r.seo_score = 0 AND r.title = 'Failed to crawl' THEN 'failed'
            WHEN JSON_EXTRACT(r.analysis_data, '$.statusCode') = 0 THEN 'failed'
            WHEN JSON_EXTRACT(r.analysis_data, '$.statusInfo.statusCategory') = 'failed' THEN 'failed'
            WHEN JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 400 THEN 'failed'
            WHEN JSON_EXTRACT(r.analysis_data, '$.error') IS NOT NULL THEN 'failed'
            WHEN JSON_EXTRACT(r.analysis_data, '$.statusInfo.details.crawlFailed') = 1 THEN 'failed'
            ELSE 'success'
          END as crawl_status,
          MIN(uv.version_number) as version_number,
          um.current_version,
          um.total_crawls
        FROM reports r 
        LEFT JOIN job_batches b ON r.batch_id = b.id 
        LEFT JOIN url_master um ON r.url = um.url
        LEFT JOIN url_versions uv ON (
          um.id = uv.url_master_id 
          AND ABS(strftime('%s', r.created_at) - strftime('%s', uv.created_at)) <= 5
        )
        ${whereClause}
        GROUP BY r.id, r.url, r.title, r.seo_score, r.analysis_data, r.recommendations, r.created_at, r.batch_id, b.name, um.current_version, um.total_crawls
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?`;
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Get total count of reports with filters for pagination
  getReportsCount(filters = {}) {
    return new Promise((resolve, reject) => {
      // Build WHERE clause based on filters
      const whereConditions = [];
      const params = [];
      
      if (filters.search) {
        whereConditions.push('(LOWER(r.url) LIKE ? OR LOWER(r.title) LIKE ?)');
        params.push(`%${filters.search.toLowerCase()}%`, `%${filters.search.toLowerCase()}%`);
      }
      
      if (filters.crawlStatus) {
        if (filters.crawlStatus === 'failed') {
          whereConditions.push(`(
            (r.seo_score = 0 AND r.title = 'Failed to crawl') OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') = 0 OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.statusCategory') = 'failed' OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 400 OR
            JSON_EXTRACT(r.analysis_data, '$.error') IS NOT NULL OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.details.crawlFailed') = 1
          )`);
        } else if (filters.crawlStatus === 'success') {
          whereConditions.push(`NOT (
            (r.seo_score = 0 AND r.title = 'Failed to crawl') OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') = 0 OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.statusCategory') = 'failed' OR
            JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 400 OR
            JSON_EXTRACT(r.analysis_data, '$.error') IS NOT NULL OR
            JSON_EXTRACT(r.analysis_data, '$.statusInfo.details.crawlFailed') = 1
          )`);
        }
      }
      
      if (filters.scoreRange) {
        switch (filters.scoreRange) {
          case 'excellent':
            whereConditions.push('r.seo_score >= 80');
            break;
          case 'good':
            whereConditions.push('r.seo_score >= 60 AND r.seo_score < 80');
            break;
          case 'fair':
            whereConditions.push('r.seo_score >= 40 AND r.seo_score < 60');
            break;
          case 'poor':
            whereConditions.push('r.seo_score < 40');
            break;
        }
      }
      
      if (filters.httpStatus) {
        switch (filters.httpStatus) {
          case '2xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 200 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 300");
            break;
          case '3xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 300 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 400");
            break;
          case '4xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 400 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 500");
            break;
          case '5xx':
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.statusCode') >= 500 AND JSON_EXTRACT(r.analysis_data, '$.statusCode') < 600");
            break;
        }
      }
      
      if (filters.dateRange) {
        const now = new Date();
        switch (filters.dateRange) {
          case 'today':
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            whereConditions.push('r.created_at >= ?');
            params.push(todayStart.toISOString());
            break;
          case 'week':
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            whereConditions.push('r.created_at >= ?');
            params.push(weekAgo.toISOString());
            break;
          case 'month':
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            whereConditions.push('r.created_at >= ?');
            params.push(monthAgo.toISOString());
            break;
          case '3months':
            const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            whereConditions.push('r.created_at >= ?');
            params.push(threeMonthsAgo.toISOString());
            break;
        }
      }
      
      if (filters.schemaPresent) {
        switch (filters.schemaPresent) {
          case 'none':
            // Pages with no schema (0 schemas)
            whereConditions.push(`(
              (JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') IS NULL OR JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.microdata') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.rdfa') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')) = 0)
            )`);
            break;
          case 'few':
            // Pages with few schemas (1-2 schemas)
            whereConditions.push(`(
              COALESCE(JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas'), 
                (COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')), 0))
              ) BETWEEN 1 AND 2
            )`);
            break;
          case 'some':
            // Pages with some schemas (3-5 schemas)
            whereConditions.push(`(
              COALESCE(JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas'), 
                (COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')), 0))
              ) BETWEEN 3 AND 5
            )`);
            break;
          case 'many':
            // Pages with many schemas (6+ schemas)
            whereConditions.push(`(
              COALESCE(JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas'), 
                (COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')), 0) + 
                 COALESCE(JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')), 0))
              ) >= 6
            )`);
            break;
          case 'yes':
            // Backward compatibility: Pages with any schema
            whereConditions.push(`(
              JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') > 0 OR
              (JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd') IS NOT NULL AND JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')) > 0) OR
              (JSON_EXTRACT(r.analysis_data, '$.schema.microdata') IS NOT NULL AND JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')) > 0) OR
              (JSON_EXTRACT(r.analysis_data, '$.schema.rdfa') IS NOT NULL AND JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')) > 0)
            )`);
            break;
          case 'no':
            // Backward compatibility: Pages without schema
            whereConditions.push(`(
              (JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') IS NULL OR JSON_EXTRACT(r.analysis_data, '$.schema.summary.totalSchemas') = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.jsonLd')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.microdata') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.microdata')) = 0) AND
              (JSON_EXTRACT(r.analysis_data, '$.schema.rdfa') IS NULL OR JSON_ARRAY_LENGTH(JSON_EXTRACT(r.analysis_data, '$.schema.rdfa')) = 0)
            )`);
            break;
        }
      }
      
      if (filters.pwaStatus) {
        switch (filters.pwaStatus) {
          case 'has':
            // Pages with PWA manifest
            whereConditions.push("JSON_EXTRACT(r.analysis_data, '$.pwa.hasManifest') = 1");
            break;
          case 'none':
            // Pages without PWA manifest
            whereConditions.push("(JSON_EXTRACT(r.analysis_data, '$.pwa.hasManifest') IS NULL OR JSON_EXTRACT(r.analysis_data, '$.pwa.hasManifest') = 0)");
            break;
        }
      }
      
      
      if (filters.imageIssues) {
        switch (filters.imageIssues) {
          case 'noalt':
            // Pages with images that have missing alt text (hasAlt = false or isEmpty = true)
            whereConditions.push(`JSON_EXTRACT(r.analysis_data, '$.images') IS NOT NULL AND (
              r.analysis_data LIKE '%"hasAlt":false%' OR
              r.analysis_data LIKE '%"isEmpty":true%'
            )`);
            break;
          case 'goodalt':
            // Pages where all images have alt text (no hasAlt=false or isEmpty=true)
            whereConditions.push(`JSON_EXTRACT(r.analysis_data, '$.images') IS NOT NULL AND 
              r.analysis_data NOT LIKE '%"hasAlt":false%' AND
              r.analysis_data NOT LIKE '%"isEmpty":true%'`);
            break;
        }
      }
      
      if (filters.issuesFilter) {
        switch (filters.issuesFilter) {
          case 'noissues':
            // Pages with no critical or warning recommendations
            whereConditions.push(`(
              r.recommendations NOT LIKE '%"type":"critical"%' AND
              r.recommendations NOT LIKE '%"type":"warning"%'
            )`);
            break;
          case 'hasissues':
            // Pages with any critical or warning recommendations
            whereConditions.push(`(
              r.recommendations LIKE '%"type":"critical"%' OR
              r.recommendations LIKE '%"type":"warning"%'
            )`);
            break;
          case 'critical':
            // Pages with critical recommendations only
            whereConditions.push('r.recommendations LIKE \'%"type":"critical"%\'');
            break;
        }
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      
      const query = `SELECT COUNT(*) as count FROM reports r ${whereClause}`;
      
      this.db.get(query, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count);
        }
      });
    });
  }

  searchReports(query) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT id, url, title, seo_score, created_at FROM reports WHERE url LIKE ? OR title LIKE ? ORDER BY created_at DESC LIMIT 50',
        [`%${query}%`, `%${query}%`],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  deleteReport(id) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM reports WHERE id = ?',
        [id],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }

  // Bulk delete all data - reports, versions, and URL masters
  deleteAllData() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');
        
        const self = this;
        let deletedCounts = {
          reports: 0,
          urlVersions: 0,
          urlMasters: 0,
          jobQueue: 0,
          jobBatches: 0
        };
        
        // First get counts for reporting
        this.db.get('SELECT COUNT(*) as count FROM reports', (err, result) => {
          if (!err) deletedCounts.reports = result.count;
        });
        
        this.db.get('SELECT COUNT(*) as count FROM url_versions', (err, result) => {
          if (!err) deletedCounts.urlVersions = result.count;
        });
        
        this.db.get('SELECT COUNT(*) as count FROM url_master', (err, result) => {
          if (!err) deletedCounts.urlMasters = result.count;
        });
        
        this.db.get('SELECT COUNT(*) as count FROM job_queue', (err, result) => {
          if (!err) deletedCounts.jobQueue = result.count;
        });
        
        this.db.get('SELECT COUNT(*) as count FROM job_batches', (err, result) => {
          if (!err) deletedCounts.jobBatches = result.count;
        });
        
        // Delete in proper order to respect foreign key constraints
        this.db.run('DELETE FROM job_queue', function(err) {
          if (err) {
            self.db.run('ROLLBACK');
            reject(err);
            return;
          }
          
          self.db.run('DELETE FROM job_batches', function(err) {
            if (err) {
              self.db.run('ROLLBACK');
              reject(err);
              return;
            }
            
            self.db.run('DELETE FROM url_versions', function(err) {
              if (err) {
                self.db.run('ROLLBACK');
                reject(err);
                return;
              }
              
              self.db.run('DELETE FROM url_master', function(err) {
                if (err) {
                  self.db.run('ROLLBACK');
                  reject(err);
                  return;
                }
                
                self.db.run('DELETE FROM reports', function(err) {
                  if (err) {
                    self.db.run('ROLLBACK');
                    reject(err);
                    return;
                  }
                  
                  // Reset auto-increment sequences
                  self.db.run('DELETE FROM sqlite_sequence WHERE name IN ("reports", "url_versions", "url_master", "job_queue", "job_batches")', function(err) {
                    if (err) {
                      console.warn('Failed to reset sequences:', err);
                    }
                    
                    self.db.run('COMMIT', function(err) {
                      if (err) {
                        reject(err);
                      } else {
                        resolve(deletedCounts);
                      }
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  }

  // User management methods
  createUser(username, hashedPassword, email = '') {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO users (username, password, email)
        VALUES (?, ?, ?)
      `);

      stmt.run([username, hashedPassword, email], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });

      stmt.finalize();
    });
  }

  getUserByUsername(username) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM users WHERE username = ? AND is_active = 1',
        [username],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  getUserById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT id, username, email, created_at, last_login FROM users WHERE id = ? AND is_active = 1',
        [id],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  updateLastLogin(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
        [userId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }

  // Batch management methods
  createBatch(name, urls, userId, options = {}) {
    return new Promise((resolve, reject) => {
      const { concurrency = 3, delay_ms = 1000 } = options;
      
      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');
        
        // Create batch
        const batchStmt = this.db.prepare(`
          INSERT INTO job_batches (name, total_urls, created_by, concurrency, delay_ms)
          VALUES (?, ?, ?, ?, ?)
        `);
        
        const self = this;
        batchStmt.run([name, urls.length, userId, concurrency, delay_ms], function(err) {
          if (err) {
            self.db.run('ROLLBACK');
            reject(err);
            return;
          }
          
          const batchId = this.lastID;
          
          // Create jobs for each URL
          const jobStmt = self.db.prepare(`
            INSERT INTO job_queue (batch_id, url, priority)
            VALUES (?, ?, ?)
          `);
          
          let stmtFinalized = false;
          
          // Insert jobs in larger batches for speed
          const batchSize = 500; // Increased batch size for faster processing
          let completed = 0;
          
          const insertBatch = (startIndex) => {
            const endIndex = Math.min(startIndex + batchSize, urls.length);
            const currentBatch = urls.slice(startIndex, endIndex);
            
            // Use Promise.all for faster parallel inserts
            const insertPromises = currentBatch.map((url, index) => {
              const priority = startIndex + index;
              return new Promise((resolveInsert, rejectInsert) => {
                jobStmt.run([batchId, url, priority], function(err) {
                  if (err) {
                    rejectInsert(err);
                  } else {
                    resolveInsert();
                  }
                });
              });
            });
            
            Promise.all(insertPromises)
              .then(() => {
                completed += currentBatch.length;
                if (completed >= urls.length) {
                  // Finalize the statement when all batches are done
                  if (!stmtFinalized) {
                    stmtFinalized = true;
                    jobStmt.finalize((finalizeErr) => {
                      if (finalizeErr) {
                        console.warn('Warning: Error finalizing job statement:', finalizeErr.message);
                      }
                    });
                  }
                  
                  self.db.run('COMMIT', (err) => {
                    if (err) {
                      reject(err);
                    } else {
                      resolve(batchId);
                    }
                  });
                } else if (endIndex < urls.length) {
                  // Continue with next batch immediately
                  insertBatch(endIndex);
                }
              })
              .catch((err) => {
                // Finalize the statement on error
                if (!stmtFinalized) {
                  stmtFinalized = true;
                  jobStmt.finalize((finalizeErr) => {
                    if (finalizeErr) {
                      console.warn('Warning: Error finalizing job statement on error:', finalizeErr.message);
                    }
                  });
                }
                
                self.db.run('ROLLBACK');
                reject(err);
              });
          };
          
          insertBatch(0);
        });
        
        batchStmt.finalize();
      });
    });
  }

  getBatch(batchId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT b.*, u.username as created_by_name 
         FROM job_batches b 
         LEFT JOIN users u ON b.created_by = u.id 
         WHERE b.id = ?`,
        [batchId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  getAllBatches(userId = null, limit = 50, offset = 0) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT b.*, u.username as created_by_name 
        FROM job_batches b 
        LEFT JOIN users u ON b.created_by = u.id
      `;
      let params = [];
      
      if (userId) {
        query += ' WHERE b.created_by = ?';
        params.push(userId);
      }
      
      query += ' ORDER BY b.created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  updateBatchStatus(batchId, status, completedUrls = null, failedUrls = null) {
    return new Promise((resolve, reject) => {
      let query = 'UPDATE job_batches SET status = ?';
      let params = [status, batchId];
      
      if (completedUrls !== null) {
        query += ', completed_urls = ?';
        params.splice(1, 0, completedUrls);
      }
      
      if (failedUrls !== null) {
        query += ', failed_urls = ?';
        params.splice(-1, 0, failedUrls);
      }
      
      if (status === 'running' && completedUrls === 0) {
        query += ', started_at = CURRENT_TIMESTAMP';
      } else if (status === 'completed' || status === 'failed') {
        query += ', completed_at = CURRENT_TIMESTAMP';
      }
      
      query += ' WHERE id = ?';
      
      this.db.run(query, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  // Job queue methods
  getPendingJobs(batchId = null, limit = 10) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT j.*, b.concurrency, b.delay_ms 
        FROM job_queue j 
        LEFT JOIN job_batches b ON j.batch_id = b.id 
        WHERE j.status = 'pending' 
          AND j.attempts < j.max_attempts 
          AND b.status != 'paused'
          AND (j.next_retry_at IS NULL OR j.next_retry_at <= CURRENT_TIMESTAMP)
      `;
      let params = [];
      
      if (batchId) {
        query += ' AND j.batch_id = ?';
        params.push(batchId);
      }
      
      query += ' ORDER BY j.priority ASC, j.created_at ASC LIMIT ?';
      params.push(limit);
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  updateJobStatus(jobId, status, errorMessage = null, reportId = null) {
    return new Promise((resolve, reject) => {
      let query = 'UPDATE job_queue SET status = ?';
      let params = [status, jobId];
      
      if (status === 'running') {
        query += ', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1';
      } else if (status === 'completed') {
        query += ', completed_at = CURRENT_TIMESTAMP, next_retry_at = NULL';
        if (reportId) {
          query += ', report_id = ?';
          params.splice(-1, 0, reportId);
        }
      } else if (status === 'failed') {
        // Don't increment attempts here - it's already incremented when status changes to 'running'
        query += ', completed_at = CURRENT_TIMESTAMP';
        if (errorMessage) {
          query += ', error_message = ?';
          params.splice(-1, 0, errorMessage);
        }
      }
      
      query += ' WHERE id = ?';
      
      this.db.run(query, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  }

  // Update job error message without changing status
  updateJobError(jobId, errorMessage) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE job_queue SET error_message = ? WHERE id = ?',
        [errorMessage, jobId],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }

  // Schedule job for retry with exponential backoff
  scheduleJobRetry(jobId, attempts, baseDelayMs = 10000, maxDelayMs = 300000) {
    return new Promise((resolve, reject) => {
      // Calculate exponential backoff: baseDelay * 2^(attempts-1) with jitter
      const exponentialDelay = Math.min(
        baseDelayMs * Math.pow(2, Math.max(0, attempts - 1)),
        maxDelayMs
      );
      
      // Add jitter (±25% randomization) to prevent thundering herd
      const jitter = exponentialDelay * 0.25 * (Math.random() - 0.5);
      const finalDelay = Math.round(exponentialDelay + jitter);
      
      // Calculate retry time
      const retryTime = new Date(Date.now() + finalDelay);
      const retryTimeString = retryTime.toISOString().replace('T', ' ').substring(0, 19);
      
      console.log(`Scheduling retry for job ${jobId}: attempt ${attempts}, delay ${finalDelay}ms, retry at ${retryTimeString}`);
      
      const query = `
        UPDATE job_queue 
        SET status = 'pending', 
            next_retry_at = ?, 
            retry_delay_ms = ?
        WHERE id = ?
      `;
      
      this.db.run(query, [retryTimeString, finalDelay, jobId], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({
            jobId,
            retryAt: retryTimeString,
            delayMs: finalDelay,
            attempt: attempts
          });
        }
      });
    });
  }

  getBatchJobs(batchId, status = null) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT j.*, r.seo_score, r.title as report_title 
        FROM job_queue j 
        LEFT JOIN reports r ON j.report_id = r.id 
        WHERE j.batch_id = ?
      `;
      let params = [batchId];
      
      if (status) {
        query += ' AND j.status = ?';
        params.push(status);
      }
      
      query += ' ORDER BY j.priority ASC, j.created_at ASC';
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  getBatchStats(batchId) {
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT 
          COUNT(*) as total_jobs,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_jobs,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_jobs,
          COUNT(CASE WHEN status = 'running' THEN 1 END) as running_jobs,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_jobs
        FROM job_queue 
        WHERE batch_id = ?
      `, [batchId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  // Enhanced saveReport to include batch and job info - now uses versioning
  saveReportWithJob(url, analysisData, report, batchId = null, jobId = null) {
    // Legacy method - now redirects to versioned system
    return this.saveVersionedReport(url, analysisData, report, batchId, jobId)
      .then(result => result.versionId);
  }

  getBatchJobsWithReports(batchId) {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT 
          j.id as job_id,
          j.url,
          j.status,
          j.error_message,
          j.created_at,
          j.completed_at as updated_at,
          r.seo_score,
          r.title,
          r.description
        FROM job_queue j 
        LEFT JOIN reports r ON j.report_id = r.id 
        WHERE j.batch_id = ?
        ORDER BY j.priority ASC, j.created_at ASC
      `, [batchId], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // URL Versioning Methods
  
  // Get or create URL master record
  getOrCreateUrlMaster(url) {
    return new Promise((resolve, reject) => {
      // First try to get existing URL master
      this.db.get(
        'SELECT * FROM url_master WHERE url = ?',
        [url],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          
          if (row) {
            // URL exists, increment version and update last crawled
            const newVersion = row.current_version + 1;
            this.db.run(
              'UPDATE url_master SET current_version = ?, last_crawled = CURRENT_TIMESTAMP, total_crawls = total_crawls + 1 WHERE id = ?',
              [newVersion, row.id],
              function(updateErr) {
                if (updateErr) {
                  reject(updateErr);
                } else {
                  resolve({
                    id: row.id,
                    url: row.url,
                    version: newVersion,
                    isNewUrl: false
                  });
                }
              }
            );
          } else {
            // New URL, create master record
            this.db.run(
              'INSERT INTO url_master (url, current_version, total_crawls) VALUES (?, 1, 1)',
              [url],
              function(insertErr) {
                if (insertErr) {
                  reject(insertErr);
                } else {
                  resolve({
                    id: this.lastID,
                    url: url,
                    version: 1,
                    isNewUrl: true
                  });
                }
              }
            );
          }
        }
      );
    });
  }
  
  // Save report with versioning
  saveVersionedReport(url, analysisData, report, batchId = null, jobId = null) {
    return new Promise(async (resolve, reject) => {
      try {
        // Get or create URL master record
        const urlMaster = await this.getOrCreateUrlMaster(url);
        
        // Save version data
        const stmt = this.db.prepare(`
          INSERT INTO url_versions (url_master_id, version_number, title, description, seo_score, analysis_data, recommendations, batch_id, job_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const self = this;
        stmt.run([
          urlMaster.id,
          urlMaster.version,
          analysisData.meta.title || '',
          analysisData.meta.description || '',
          report.score,
          JSON.stringify(analysisData),
          JSON.stringify(report.recommendations),
          batchId,
          jobId
        ], function(err) {
          if (err) {
            reject(err);
          } else {
            const versionId = this.lastID; // Store version ID
            
            // Also save to original reports table for backward compatibility
            const reportStmt = self.db.prepare(`
              INSERT INTO reports (url, title, description, seo_score, analysis_data, recommendations, batch_id, job_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            reportStmt.run([
              url,
              analysisData.meta.title || '',
              analysisData.meta.description || '',
              report.score,
              JSON.stringify(analysisData),
              JSON.stringify(report.recommendations),
              batchId,
              jobId
            ], function(reportErr) {
              if (reportErr) {
                console.warn('Failed to save backward compatibility report:', reportErr);
                reportStmt.finalize();
                resolve({
                  versionId: versionId,
                  urlMasterId: urlMaster.id,
                  version: urlMaster.version,
                  isNewUrl: urlMaster.isNewUrl,
                  reportId: null // No report ID if failed
                });
              } else {
                const reportId = this.lastID; // Store report ID
                reportStmt.finalize();
                resolve({
                  versionId: versionId,
                  urlMasterId: urlMaster.id,
                  version: urlMaster.version,
                  isNewUrl: urlMaster.isNewUrl,
                  reportId: reportId // The reports table ID
                });
              }
            });
          }
        });

        stmt.finalize();
      } catch (error) {
        reject(error);
      }
    });
  }
  
  // Get all versions for a URL
  getUrlVersions(url) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT 
          uv.*,
          um.url,
          um.total_crawls,
          um.first_crawled,
          b.name as batch_name,
          MIN(r.id) as report_id
        FROM url_versions uv
        JOIN url_master um ON uv.url_master_id = um.id
        LEFT JOIN job_batches b ON uv.batch_id = b.id
        LEFT JOIN reports r ON (r.url = um.url AND ABS(strftime('%s', uv.created_at) - strftime('%s', r.created_at)) <= 5)
        WHERE um.url = ?
        GROUP BY uv.id, uv.url_master_id, uv.version_number, uv.title, uv.description, uv.seo_score, uv.analysis_data, uv.recommendations, uv.batch_id, uv.job_id, uv.created_at, um.url, um.total_crawls, um.first_crawled, b.name
        ORDER BY uv.version_number DESC`,
        [url],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            // Parse JSON data and add fallback report_id
            const versions = rows.map(row => ({
              ...row,
              analysis_data: JSON.parse(row.analysis_data),
              recommendations: JSON.parse(row.recommendations),
              // Use the mapped report_id or fall back to the version id
              report_id: row.report_id || row.id
            }));
            resolve(versions);
          }
        }
      );
    });
  }
  
  // Get specific version of a URL
  getUrlVersion(url, version) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT 
          uv.*,
          um.url,
          um.total_crawls,
          b.name as batch_name
        FROM url_versions uv
        JOIN url_master um ON uv.url_master_id = um.id
        LEFT JOIN job_batches b ON uv.batch_id = b.id
        WHERE um.url = ? AND uv.version_number = ?`,
        [url, version],
        (err, row) => {
          if (err) {
            reject(err);
          } else if (row) {
            row.analysis_data = JSON.parse(row.analysis_data);
            row.recommendations = JSON.parse(row.recommendations);
            resolve(row);
          } else {
            resolve(null);
          }
        }
      );
    });
  }
  
  // Get URL master by ID
  getUrlMasterById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM url_master WHERE id = ?',
        [id],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }
  
  // Get all URLs with their latest version info
  getAllUrlsWithVersions(limit = 50, offset = 0, filters = {}) {
    return new Promise((resolve, reject) => {
      // Build WHERE clause based on filters
      const whereConditions = [];
      const params = [];
      
      if (filters.search) {
        whereConditions.push('(LOWER(um.url) LIKE ? OR LOWER(uv.title) LIKE ?)');
        params.push(`%${filters.search.toLowerCase()}%`, `%${filters.search.toLowerCase()}%`);
      }
      
      if (filters.scoreRange) {
        switch (filters.scoreRange) {
          case 'excellent':
            whereConditions.push('uv.seo_score >= 80');
            break;
          case 'good':
            whereConditions.push('uv.seo_score >= 60 AND uv.seo_score < 80');
            break;
          case 'fair':
            whereConditions.push('uv.seo_score >= 40 AND uv.seo_score < 60');
            break;
          case 'poor':
            whereConditions.push('uv.seo_score < 40');
            break;
        }
      }
      
      if (filters.versionRange) {
        switch (filters.versionRange) {
          case 'single':
            whereConditions.push('um.current_version = 1');
            break;
          case 'multiple':
            whereConditions.push('um.current_version > 1');
            break;
          case 'high':
            whereConditions.push('um.current_version >= 5');
            break;
        }
      }
      
      if (filters.crawlFrequency) {
        switch (filters.crawlFrequency) {
          case 'once':
            whereConditions.push('um.total_crawls = 1');
            break;
          case 'few':
            whereConditions.push('um.total_crawls BETWEEN 2 AND 5');
            break;
          case 'many':
            whereConditions.push('um.total_crawls > 5');
            break;
        }
      }
      
      if (filters.dateRange) {
        const now = new Date();
        switch (filters.dateRange) {
          case 'today':
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            whereConditions.push('um.last_crawled >= ?');
            params.push(todayStart.toISOString());
            break;
          case 'week':
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            whereConditions.push('um.last_crawled >= ?');
            params.push(weekAgo.toISOString());
            break;
          case 'month':
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            whereConditions.push('um.last_crawled >= ?');
            params.push(monthAgo.toISOString());
            break;
          case '3months':
            const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            whereConditions.push('um.last_crawled >= ?');
            params.push(threeMonthsAgo.toISOString());
            break;
        }
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      
      // Add limit and offset parameters
      params.push(limit, offset);
      
      this.db.all(
        `SELECT 
          um.*,
          uv.title,
          uv.seo_score,
          uv.created_at as last_version_date
        FROM url_master um
        LEFT JOIN url_versions uv ON um.id = uv.url_master_id AND uv.version_number = um.current_version
        ${whereClause}
        ORDER BY um.last_crawled DESC
        LIMIT ? OFFSET ?`,
        params,
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  // Get total count of unique URLs in the database
  getTotalUniqueUrlsCount(filters = {}) {
    return new Promise((resolve, reject) => {
      // Build WHERE clause based on filters
      const whereConditions = [];
      const params = [];
      
      if (filters.search) {
        whereConditions.push('(LOWER(um.url) LIKE ? OR LOWER(uv.title) LIKE ?)');
        params.push(`%${filters.search.toLowerCase()}%`, `%${filters.search.toLowerCase()}%`);
      }
      
      if (filters.scoreRange) {
        switch (filters.scoreRange) {
          case 'excellent':
            whereConditions.push('uv.seo_score >= 80');
            break;
          case 'good':
            whereConditions.push('uv.seo_score >= 60 AND uv.seo_score < 80');
            break;
          case 'fair':
            whereConditions.push('uv.seo_score >= 40 AND uv.seo_score < 60');
            break;
          case 'poor':
            whereConditions.push('uv.seo_score < 40');
            break;
        }
      }
      
      if (filters.versionRange) {
        switch (filters.versionRange) {
          case 'single':
            whereConditions.push('um.current_version = 1');
            break;
          case 'multiple':
            whereConditions.push('um.current_version > 1');
            break;
          case 'high':
            whereConditions.push('um.current_version >= 5');
            break;
        }
      }
      
      if (filters.crawlFrequency) {
        switch (filters.crawlFrequency) {
          case 'once':
            whereConditions.push('um.total_crawls = 1');
            break;
          case 'few':
            whereConditions.push('um.total_crawls BETWEEN 2 AND 5');
            break;
          case 'many':
            whereConditions.push('um.total_crawls > 5');
            break;
        }
      }
      
      if (filters.dateRange) {
        const now = new Date();
        switch (filters.dateRange) {
          case 'today':
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            whereConditions.push('um.last_crawled >= ?');
            params.push(todayStart.toISOString());
            break;
          case 'week':
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            whereConditions.push('um.last_crawled >= ?');
            params.push(weekAgo.toISOString());
            break;
          case 'month':
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            whereConditions.push('um.last_crawled >= ?');
            params.push(monthAgo.toISOString());
            break;
          case '3months':
            const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
            whereConditions.push('um.last_crawled >= ?');
            params.push(threeMonthsAgo.toISOString());
            break;
        }
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      
      const query = `SELECT COUNT(DISTINCT um.id) as count 
                     FROM url_master um
                     LEFT JOIN url_versions uv ON um.id = uv.url_master_id AND uv.version_number = um.current_version
                     ${whereClause}`;
      
      this.db.get(query, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row.count);
        }
      });
    });
  }
  
  // Save failed report entry
  saveFailedReport(url, errorMessage, batchId = null, jobId = null) {
    return new Promise((resolve, reject) => {
      const failedAnalysisData = {
        url: url,
        statusCode: 0,
        statusInfo: {
          statusCode: 0,
          statusCategory: "failed",
          statusMessage: errorMessage,
          isHealthy: false,
          details: {
            error: errorMessage,
            crawlFailed: true
          }
        },
        meta: {
          title: "Failed to crawl",
          description: `Crawl failed: ${errorMessage}`,
          titleLength: 15,
          descriptionLength: errorMessage.length + 14
        },
        error: {
          message: errorMessage,
          timestamp: new Date().toISOString(),
          type: "crawl_failure"
        }
      };

      const failedRecommendations = [
        {
          type: "error",
          issue: "Crawl Failed",
          suggestion: `Unable to analyze this URL: ${errorMessage}`,
          priority: "high"
        }
      ];

      const stmt = this.db.prepare(`
        INSERT INTO reports (url, title, description, seo_score, analysis_data, recommendations, batch_id, job_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run([
        url,
        'Failed to crawl',
        `Crawl failed: ${errorMessage}`,
        0, // SEO score of 0 for failed crawls
        JSON.stringify(failedAnalysisData),
        JSON.stringify(failedRecommendations),
        batchId,
        jobId
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });

      stmt.finalize();
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = Database;