const Database = require('./database');
const SEOCrawler = require('./crawler');
const SEOReporter = require('./reporter');
const PerformanceOptimizer = require('./performance-optimizer');
const cron = require('node-cron');

class QueueManager {
  constructor(io = null, database = null) {
    this.db = database || new Database();
    this.crawler = new SEOCrawler();
    this.reporter = new SEOReporter();
    this.io = io; // Socket.io instance for real-time updates
    this.isProcessing = false;
    this.activeJobs = new Map(); // Track running jobs
    
    // Initialize performance optimizer
    this.performanceOptimizer = new PerformanceOptimizer();
    this.maxConcurrentJobs = this.performanceOptimizer.currentConcurrency;
    
    // Performance tracking
    this.performanceStats = {
      jobsCompleted: 0,
      jobsFailed: 0,
      totalResponseTime: 0,
      lastAdjustment: Date.now(),
      adjustmentInterval: 30000 // 30 seconds
    };
    
    console.log(`Queue Manager initialized with dynamic concurrency: ${this.maxConcurrentJobs} jobs`);
    
    // Don't start the processor immediately - wait for explicit start
    this.processorStarted = false;
  }

  // Start the background processor
  startProcessor() {
    if (this.processorStarted) {
      console.log('Queue processor already started');
      return;
    }
    
    // Process jobs every 1 second for faster processing
    cron.schedule('*/1 * * * * *', () => {
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
    
    this.processorStarted = true;
    console.log('Queue processor started');
  }

  // Main queue processing logic
  async processQueue() {
    // Check if we should adjust concurrency
    await this.adjustConcurrencyIfNeeded();
    
    if (this.activeJobs.size >= this.maxConcurrentJobs) {
      return; // Max concurrent jobs reached
    }

    this.isProcessing = true;
    
    try {
      // Get pending jobs
      const availableSlots = this.maxConcurrentJobs - this.activeJobs.size;
      const jobs = await this.db.getPendingJobs(null, availableSlots);
      
      if (jobs.length === 0) {
        this.isProcessing = false;
        return;
      }
      
      console.log(`Processing ${jobs.length} jobs (${this.activeJobs.size}/${this.maxConcurrentJobs} active)...`);
      
      // Process each job
      for (const job of jobs) {
        if (this.activeJobs.size >= this.maxConcurrentJobs) {
          break; // Don't exceed limit
        }
        
        this.processJob(job);
      }
      
    } catch (error) {
      console.error('Queue processing error:', error);
    }
    
    this.isProcessing = false;
  }

  // Process individual job
  async processJob(job) {
    const jobId = job.id;
    this.activeJobs.set(jobId, job);
    
    try {
      console.log(`Starting job ${jobId}: ${job.url}`);
      
      // Update job status to running
      await this.db.updateJobStatus(jobId, 'running');
      
      // Update batch status if it's the first job
      const batchStats = await this.db.getBatchStats(job.batch_id);
      if (batchStats.running_jobs === 1 && batchStats.completed_jobs === 0) {
        await this.db.updateBatchStatus(job.batch_id, 'running', 0, 0);
      }
      
      // Emit real-time update
      this.emitJobUpdate(job.batch_id, jobId, 'running', { url: job.url });
      
      // Apply delay if specified
      if (job.delay_ms > 0) {
        await this.delay(job.delay_ms);
      }
      
      // Calculate timeout based on attempt (exponential backoff)
      const baseTimeout = job.base_timeout_ms || 10000; // 10 seconds default
      const timeoutMs = Math.min(baseTimeout * Math.pow(2, job.attempts), 120000); // Max 2 minutes
      
      console.log(`Starting analysis for ${job.url} (attempt ${job.attempts}/${job.max_attempts}) with ${timeoutMs}ms timeout`);
      
      // Perform SEO analysis with dynamic timeout
      const analysis = await Promise.race([
        this.crawler.analyzePage(job.url, timeoutMs),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Analysis timeout after ${timeoutMs}ms (attempt ${job.attempts})`)), timeoutMs)
        )
      ]);
      
      // Generate report
      const report = this.reporter.generateDetailedReport(analysis);
      
      // Save report with versioning for the original URL
      const versionResult = await this.db.saveVersionedReport(
        job.url, 
        analysis, 
        report, 
        job.batch_id, 
        jobId
      );
      
      // Check if we need to crawl the final URL separately (if redirected)
      const finalUrl = analysis?.details?.finalUrl || analysis?.finalUrl;
      let finalUrlReportId = null;
      
      if (finalUrl && finalUrl !== job.url) {
        console.log(`URL ${job.url} redirected to ${finalUrl}, creating separate analysis for final URL`);
        
        try {
          // Analyze the final URL separately with the same timeout
          const finalAnalysis = await Promise.race([
            this.crawler.analyzePage(finalUrl, timeoutMs),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Final URL analysis timeout after ${timeoutMs}ms`)), timeoutMs)
            )
          ]);
          
          // Generate report for final URL
          const finalReport = this.reporter.generateDetailedReport(finalAnalysis);
          
          // Save final URL report (create new job entry for tracking)
          const finalVersionResult = await this.db.saveVersionedReport(
            finalUrl, 
            finalAnalysis, 
            finalReport, 
            job.batch_id, 
            null // No specific job ID for final URL
          );
          
          finalUrlReportId = finalVersionResult.versionId;
          
          console.log(`Final URL ${finalUrl} analyzed and saved as version ${finalVersionResult.version} (Score: ${finalReport.score})`);
          
          // Emit update for final URL analysis
          this.emitJobUpdate(job.batch_id, `${jobId}-final`, 'completed', { 
            url: finalUrl, 
            reportId: finalUrlReportId,
            seoScore: finalReport.score,
            isRedirectTarget: true,
            originalUrl: job.url
          });
          
        } catch (finalUrlError) {
          console.error(`Failed to analyze final URL ${finalUrl}:`, finalUrlError.message);
          // Don't fail the main job if final URL analysis fails
        }
      }
      
      console.log(`URL ${job.url} saved as version ${versionResult.version} ${versionResult.isNewUrl ? '(new URL)' : '(existing URL)'}`);
      
      // Use version ID as report ID for compatibility
      const reportId = versionResult.versionId;
      
      // Update job status to completed
      await this.db.updateJobStatus(jobId, 'completed', null, reportId);
      
      // Update batch progress
      await this.updateBatchProgress(job.batch_id);
      
      // Emit completion update
      this.emitJobUpdate(job.batch_id, jobId, 'completed', { 
        url: job.url, 
        reportId,
        seoScore: report.score,
        finalUrlReportId: finalUrlReportId,
        finalUrl: finalUrl !== job.url ? finalUrl : null
      });
      
      // Track performance metrics
      const jobDuration = Date.now() - new Date(job.started_at || job.created_at).getTime();
      this.updatePerformanceStats(true, jobDuration);
      
      const finalUrlInfo = finalUrlReportId ? ` + Final URL (${finalUrl})` : '';
      console.log(`Completed job ${jobId}: ${job.url} (Score: ${report.score})${finalUrlInfo}`);
      
    } catch (error) {
      console.error(`Job ${jobId} failed on attempt ${job.attempts}:`, error.message);
      
      // Track performance metrics for failed job
      const jobDuration = Date.now() - new Date(job.started_at || job.created_at).getTime();
      this.updatePerformanceStats(false, jobDuration);
      
      // Check if we should retry or mark as permanently failed
      if (job.attempts < job.max_attempts) {
        // Schedule retry with exponential backoff
        try {
          const baseDelay = job.base_timeout_ms || 10000;
          const retryInfo = await this.db.scheduleJobRetry(jobId, job.attempts + 1, baseDelay);
          
          console.log(`Scheduled retry for job ${jobId}: ${job.url} - attempt ${retryInfo.attempt} in ${retryInfo.delayMs}ms`);
          
          // Don't update status here - scheduleJobRetry already set it to 'pending' with next_retry_at
          // Just update the error message
          await this.db.updateJobError(jobId, error.message);
          
          // Emit retry update
          this.emitJobUpdate(job.batch_id, jobId, 'retry_scheduled', { 
            url: job.url, 
            error: error.message,
            nextRetry: retryInfo.retryAt,
            attempt: retryInfo.attempt,
            maxAttempts: job.max_attempts
          });
          
        } catch (retryError) {
          console.error(`Failed to schedule retry for job ${jobId}:`, retryError.message);
          // Fall back to permanent failure
          await this.handlePermanentFailure(job, error, jobId);
        }
      } else {
        // Permanently failed - create failed report and mark as failed
        await this.handlePermanentFailure(job, error, jobId);
      }
      
    } finally {
      // Remove from active jobs
      this.activeJobs.delete(jobId);
    }
  }

  // Handle permanent job failure after all retries exhausted
  async handlePermanentFailure(job, error, jobId) {
    console.log(`Job ${jobId} permanently failed after ${job.attempts} attempts: ${job.url}`);
    
    // Create failed report entry so it appears in reports overview
    try {
      const reportId = await this.db.saveFailedReport(
        job.url, 
        error.message, 
        job.batch_id, 
        jobId
      );
      
      // Update job status to failed with report ID
      await this.db.updateJobStatus(jobId, 'failed', error.message, reportId);
      
      console.log(`Created failed report ${reportId} for permanently failed job ${jobId}: ${job.url}`);
    } catch (reportError) {
      console.error(`Failed to create failed report for job ${jobId}:`, reportError.message);
      
      // Update job status to failed without report ID
      await this.db.updateJobStatus(jobId, 'failed', error.message);
    }
    
    // Update batch progress
    await this.updateBatchProgress(job.batch_id);
    
    // Emit failure update
    this.emitJobUpdate(job.batch_id, jobId, 'failed', { 
      url: job.url, 
      error: error.message,
      attempts: job.attempts,
      maxAttempts: job.max_attempts
    });
  }

  // Update batch progress and status
  async updateBatchProgress(batchId) {
    try {
      const stats = await this.db.getBatchStats(batchId);
      const batch = await this.db.getBatch(batchId);
      
      if (!batch) return;
      
      const completedUrls = stats.completed_jobs;
      const failedUrls = stats.failed_jobs;
      const totalUrls = batch.total_urls;
      
      // Determine batch status
      let status = 'running';
      if (completedUrls + failedUrls >= totalUrls) {
        status = failedUrls === totalUrls ? 'failed' : 'completed';
      }
      
      // Update batch
      await this.db.updateBatchStatus(batchId, status, completedUrls, failedUrls);
      
      // Emit batch progress update
      this.emitBatchUpdate(batchId, {
        status,
        completed: completedUrls,
        failed: failedUrls,
        total: totalUrls,
        progress: Math.round((completedUrls + failedUrls) / totalUrls * 100)
      });
      
      if (status === 'completed' || status === 'failed') {
        console.log(`Batch ${batchId} ${status} - ${completedUrls}/${totalUrls} successful`);
      }
      
    } catch (error) {
      console.error('Error updating batch progress:', error);
    }
  }

  // Submit bulk URLs for processing
  async submitBulkUrls(urls, userId, batchName = null, options = {}) {
    try {
      // Clean and validate URLs with enhanced processing (now async with DNS validation)
      const validationResult = await this.validateUrls(urls, { skipDnsValidation: options.skipDnsValidation || false });
      
      if (validationResult.validUrls.length === 0) {
        throw new Error('No valid URLs provided after validation and duplicate removal');
      }
      
      // Create batch name if not provided
      if (!batchName) {
        batchName = `Batch ${new Date().toISOString().split('T')[0]} (${validationResult.validUrls.length} URLs)`;
      }
      
      // Create batch in database
      const batchId = await this.db.createBatch(batchName, validationResult.validUrls, userId, options);
      
      console.log(`Created batch ${batchId} with ${validationResult.validUrls.length} valid URLs`);
      console.log(`Processing summary: ${validationResult.stats.valid} valid, ${validationResult.stats.duplicates} duplicates removed, ${validationResult.stats.invalid} invalid`);
      
      // Emit batch creation event
      this.emitBatchUpdate(batchId, {
        status: 'pending',
        completed: 0,
        failed: 0,
        total: validationResult.validUrls.length,
        progress: 0
      });
      
      // Return batch info with validation details
      return {
        batchId,
        validationSummary: validationResult.stats,
        duplicatesRemoved: validationResult.duplicatesRemoved,
        skippedUrls: validationResult.skippedUrls
      };
      
    } catch (error) {
      console.error('Error submitting bulk URLs:', error);
      throw error;
    }
  }

  // Validate and clean URLs with enhanced processing and bulk DNS validation
  async validateUrls(urls, options = {}) {
    const urlList = Array.isArray(urls) ? urls : urls.split('\n');
    const cleanUrls = [];
    const seenUrls = new Set();
    const skippedUrls = [];
    const duplicatesRemoved = [];
    const skipDnsValidation = options.skipDnsValidation || false;
    
    console.log(`Processing ${urlList.length} URLs for validation...`);
    
    // Step 1: Basic validation and normalization
    const normalizedUrls = [];
    for (let originalUrl of urlList) {
      let url = originalUrl.trim();
      
      // Skip empty lines and comments
      if (!url || url.startsWith('#') || url.startsWith('//')) continue;
      
      // Remove common prefixes that users might include
      url = url.replace(/^(www\.)?/, '');
      
      // Add protocol if missing
      if (!url.match(/^https?:\/\//)) {
        // Default to HTTPS for security
        url = 'https://' + url;
      }
      
      // Normalize URL (remove trailing slashes, convert to lowercase domain)
      try {
        const urlObj = new URL(url);
        
        // Normalize the URL
        urlObj.hostname = urlObj.hostname.toLowerCase();
        urlObj.pathname = urlObj.pathname === '/' ? '' : urlObj.pathname.replace(/\/$/, '');
        
        const normalizedUrl = urlObj.toString();
        
        // Check for duplicates
        if (seenUrls.has(normalizedUrl)) {
          duplicatesRemoved.push({
            original: originalUrl,
            normalized: normalizedUrl
          });
          continue;
        }
        
        // Basic validation
        if (this.isValidWebUrl(urlObj)) {
          seenUrls.add(normalizedUrl);
          normalizedUrls.push({ original: originalUrl, normalized: normalizedUrl, hostname: urlObj.hostname });
        } else {
          skippedUrls.push({
            original: originalUrl,
            reason: 'Invalid domain or protocol'
          });
        }
        
      } catch (e) {
        skippedUrls.push({
          original: originalUrl,
          reason: 'Malformed URL: ' + e.message
        });
      }
    }
    
    // Step 2: DNS validation (optional for bulk submissions)
    let dnsResults = [];
    if (skipDnsValidation) {
      console.log(`Skipping DNS validation for ${normalizedUrls.length} URLs (bulk mode)...`);
      // Accept all normalized URLs without DNS validation in bulk mode
      dnsResults = normalizedUrls.map(urlData => ({ ...urlData, dnsValid: true }));
    } else {
      console.log(`Performing DNS validation for ${normalizedUrls.length} URLs...`);
      const dns = require('dns').promises;
      const dnsPromises = normalizedUrls.map(async (urlData) => {
        try {
          await dns.resolve(urlData.hostname);
          return { ...urlData, dnsValid: true };
        } catch (e) {
          return { ...urlData, dnsValid: false, dnsError: e.message };
        }
      });
      
      // Process DNS results in batches to avoid overwhelming the system
      const batchSize = 50;
      for (let i = 0; i < dnsPromises.length; i += batchSize) {
        const batch = dnsPromises.slice(i, i + batchSize);
        try {
          const batchResults = await Promise.all(batch);
          dnsResults.push(...batchResults);
        } catch (error) {
          console.error(`DNS validation batch ${i}-${i + batchSize} failed:`, error.message);
          // On DNS batch failure, accept URLs without DNS validation
          const fallbackResults = normalizedUrls.slice(i, i + batchSize).map(urlData => ({ 
            ...urlData, 
            dnsValid: true, 
            dnsSkipped: true 
          }));
          dnsResults.push(...fallbackResults);
        }
        
        // Small delay between batches to be nice to DNS servers
        if (i + batchSize < dnsPromises.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    
    // Step 3: Filter based on DNS results
    for (const result of dnsResults) {
      if (result.dnsValid) {
        cleanUrls.push(result.normalized);
      } else {
        skippedUrls.push({
          original: result.original,
          reason: `DNS resolution failed: ${result.dnsError}`
        });
      }
    }
    
    // Log processing results
    console.log(`URL Processing Results:`);
    console.log(`- Valid URLs ${skipDnsValidation ? '(DNS validation skipped)' : '(with DNS)'}: ${cleanUrls.length}`);
    console.log(`- Duplicates removed: ${duplicatesRemoved.length}`);
    console.log(`- Invalid URLs skipped: ${skippedUrls.length}`);
    
    return {
      validUrls: cleanUrls,
      duplicatesRemoved,
      skippedUrls,
      stats: {
        total: urlList.length,
        valid: cleanUrls.length,
        duplicates: duplicatesRemoved.length,
        invalid: skippedUrls.length
      }
    };
  }

  // Enhanced URL validation
  isValidWebUrl(urlObj) {
    // Only allow HTTP and HTTPS protocols
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return false;
    }
    
    // Check for valid hostname
    if (!urlObj.hostname || urlObj.hostname.length < 3) {
      return false;
    }
    
    // Reject localhost and private IPs for security
    if (urlObj.hostname === 'localhost' || 
        urlObj.hostname.startsWith('127.') ||
        urlObj.hostname.startsWith('192.168.') ||
        urlObj.hostname.startsWith('10.') ||
        urlObj.hostname.match(/^172\.(1[6-9]|2[0-9]|3[01])\./)) {
      return false;
    }
    
    // Must have at least one dot in hostname (except for special cases)
    if (!urlObj.hostname.includes('.') && urlObj.hostname !== 'localhost') {
      return false;
    }
    
    return true;
  }

  // Cancel batch
  async cancelBatch(batchId) {
    try {
      // Update batch status
      await this.db.updateBatchStatus(batchId, 'cancelled');
      
      // Cancel pending jobs
      const pendingJobs = await this.db.getBatchJobs(batchId, 'pending');
      for (const job of pendingJobs) {
        await this.db.updateJobStatus(job.id, 'cancelled');
      }
      
      // Emit cancellation event
      this.emitBatchUpdate(batchId, {
        status: 'cancelled'
      });
      
      console.log(`Cancelled batch ${batchId}`);
      return true;
      
    } catch (error) {
      console.error('Error cancelling batch:', error);
      throw error;
    }
  }

  // Retry failed jobs in batch
  async retryBatch(batchId) {
    try {
      const failedJobs = await this.db.getBatchJobs(batchId, 'failed');
      
      for (const job of failedJobs) {
        await this.db.updateJobStatus(job.id, 'pending');
      }
      
      if (failedJobs.length > 0) {
        await this.db.updateBatchStatus(batchId, 'running');
        
        this.emitBatchUpdate(batchId, {
          status: 'running'
        });
        
        console.log(`Restarted ${failedJobs.length} failed jobs in batch ${batchId}`);
      }
      
      return failedJobs.length;
      
    } catch (error) {
      console.error('Error retrying batch:', error);
      throw error;
    }
  }

  // Pause batch processing
  async pauseBatch(batchId) {
    try {
      // Update batch status to paused
      await this.db.updateBatchStatus(batchId, 'paused');
      
      // Cancel pending jobs (set them to paused)
      const pendingJobs = await this.db.getBatchJobs(batchId, 'pending');
      for (const job of pendingJobs) {
        await this.db.updateJobStatus(job.id, 'paused');
      }
      
      // Emit pause event
      this.emitBatchUpdate(batchId, {
        status: 'paused'
      });
      
      console.log(`Paused batch ${batchId} - ${pendingJobs.length} jobs paused`);
      return pendingJobs.length;
      
    } catch (error) {
      console.error('Error pausing batch:', error);
      throw error;
    }
  }

  // Resume batch processing
  async resumeBatch(batchId) {
    try {
      // Update batch status to running
      await this.db.updateBatchStatus(batchId, 'running');
      
      // Resume paused jobs (set them back to pending)
      const pausedJobs = await this.db.getBatchJobs(batchId, 'paused');
      for (const job of pausedJobs) {
        await this.db.updateJobStatus(job.id, 'pending');
      }
      
      // Emit resume event
      this.emitBatchUpdate(batchId, {
        status: 'running'
      });
      
      console.log(`Resumed batch ${batchId} - ${pausedJobs.length} jobs resumed`);
      return pausedJobs.length;
      
    } catch (error) {
      console.error('Error resuming batch:', error);
      throw error;
    }
  }

  // Emit job update via Socket.IO
  emitJobUpdate(batchId, jobId, status, data = {}) {
    if (this.io) {
      this.io.emit('job-update', {
        batchId,
        jobId,
        status,
        ...data,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Emit batch update via Socket.IO
  emitBatchUpdate(batchId, data = {}) {
    if (this.io) {
      this.io.emit('batch-update', {
        batchId,
        ...data,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Utility delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Update performance statistics
  updatePerformanceStats(success, duration) {
    if (success) {
      this.performanceStats.jobsCompleted++;
    } else {
      this.performanceStats.jobsFailed++;
    }
    
    this.performanceStats.totalResponseTime += duration;
    
    // Update optimizer metrics
    const totalJobs = this.performanceStats.jobsCompleted + this.performanceStats.jobsFailed;
    if (totalJobs > 0) {
      const avgResponseTime = this.performanceStats.totalResponseTime / totalJobs;
      const successRate = this.performanceStats.jobsCompleted / totalJobs;
      
      this.performanceOptimizer.updateMetrics({
        avgResponseTime,
        successRate,
        throughput: totalJobs / ((Date.now() - this.performanceStats.lastAdjustment) / 60000) // jobs per minute
      });
    }
  }

  // Adjust concurrency based on performance
  async adjustConcurrencyIfNeeded() {
    const now = Date.now();
    if (now - this.performanceStats.lastAdjustment < this.performanceStats.adjustmentInterval) {
      return; // Too soon to adjust
    }

    try {
      const queueStatus = {
        activeJobs: this.activeJobs.size,
        maxConcurrentJobs: this.maxConcurrentJobs,
        isProcessing: this.isProcessing
      };

      const optimization = this.performanceOptimizer.getOptimizationRecommendation(queueStatus);
      
      if (optimization.shouldAdjust) {
        const oldConcurrency = this.maxConcurrentJobs;
        this.maxConcurrentJobs = optimization.recommendedConcurrency;
        
        console.log(`🚀 Concurrency adjusted: ${oldConcurrency} → ${this.maxConcurrentJobs} (${optimization.reasoning})`);
        
        // Emit optimization update
        this.emitOptimizationUpdate(optimization);
      }

      this.performanceStats.lastAdjustment = now;
      
      // Reset stats for next interval
      this.performanceStats.jobsCompleted = 0;
      this.performanceStats.jobsFailed = 0;
      this.performanceStats.totalResponseTime = 0;
      
    } catch (error) {
      console.error('Error adjusting concurrency:', error.message);
    }
  }

  // Emit optimization update via Socket.IO
  emitOptimizationUpdate(optimization) {
    if (this.io) {
      this.io.emit('optimization-update', {
        ...optimization,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Get enhanced queue status with performance metrics
  getQueueStatus() {
    const queueStatus = {
      activeJobs: this.activeJobs.size,
      maxConcurrentJobs: this.maxConcurrentJobs,
      isProcessing: this.isProcessing
    };
    
    // Get optimization recommendation
    const optimization = this.performanceOptimizer.getOptimizationRecommendation(queueStatus);
    
    return {
      ...queueStatus,
      performance: {
        optimization,
        stats: this.performanceStats,
        systemInfo: this.performanceOptimizer.systemInfo
      }
    };
  }

  // Get detailed performance report
  getPerformanceReport() {
    return this.performanceOptimizer.getPerformanceReport();
  }

  // Graceful shutdown
  async shutdown() {
    console.log('Shutting down queue manager...');
    
    // Wait for active jobs to complete (with timeout)
    const timeout = 30000; // 30 seconds
    const start = Date.now();
    
    while (this.activeJobs.size > 0 && (Date.now() - start) < timeout) {
      console.log(`Waiting for ${this.activeJobs.size} active jobs to complete...`);
      await this.delay(1000);
    }
    
    if (this.activeJobs.size > 0) {
      console.warn(`Forced shutdown with ${this.activeJobs.size} active jobs`);
    }
    
    this.db.close();
    console.log('Queue manager shutdown complete');
  }
}

module.exports = QueueManager;