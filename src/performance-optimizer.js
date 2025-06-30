const os = require('os');
const { performance } = require('perf_hooks');
const axios = require('axios');

class PerformanceOptimizer {
  constructor() {
    this.systemInfo = {
      cpuCores: os.cpus().length,
      totalMemory: os.totalmem(),
      platform: os.platform(),
      arch: os.arch()
    };
    
    this.performanceMetrics = {
      avgResponseTime: 1000, // Default 1 second
      successRate: 1.0,
      memoryUsage: 0,
      cpuUsage: 0,
      networkLatency: 100, // Default 100ms
      internetSpeed: 100, // Default 100 Mbps
      concurrentJobsHistory: [],
      throughputHistory: []
    };
    
    this.config = {
      minConcurrentJobs: 5,
      maxConcurrentJobs: this.calculateMaxConcurrency(),
      targetResponseTime: 3000, // 3 seconds target
      targetSuccessRate: 0.95,
      adjustmentInterval: 30000, // 30 seconds
      speedTestInterval: 300000, // 5 minutes
      lastSpeedTest: 0
    };
    
    this.currentConcurrency = this.config.minConcurrentJobs;
    
    console.log(`Performance Optimizer initialized:`);
    console.log(`- CPU Cores: ${this.systemInfo.cpuCores}`);
    console.log(`- Total Memory: ${Math.round(this.systemInfo.totalMemory / 1024 / 1024 / 1024)}GB`);
    console.log(`- Max Concurrency Range: ${this.config.minConcurrentJobs}-${this.config.maxConcurrentJobs}`);
    
    // Start monitoring
    this.startMonitoring();
  }
  
  // Calculate maximum concurrency based on system specs
  calculateMaxConcurrency() {
    const cpuCores = this.systemInfo.cpuCores;
    const memoryGB = Math.round(this.systemInfo.totalMemory / 1024 / 1024 / 1024);
    
    // Base calculation: 2-4 jobs per CPU core, adjusted for memory
    let baseConcurrency = cpuCores * 3;
    
    // Memory adjustment (each job uses ~50-100MB)
    const memoryLimit = Math.floor(memoryGB * 1024 * 0.7 / 75); // Use 70% of RAM, 75MB per job
    
    // Take the lower of CPU-based or memory-based limits
    let maxConcurrency = Math.min(baseConcurrency, memoryLimit);
    
    // Platform-specific adjustments
    if (this.systemInfo.platform === 'darwin') {
      // macOS typically handles more concurrent connections well
      maxConcurrency = Math.min(maxConcurrency * 1.2, 200);
    } else if (this.systemInfo.platform === 'linux') {
      // Linux can typically handle more
      maxConcurrency = Math.min(maxConcurrency * 1.5, 300);
    } else if (this.systemInfo.platform === 'win32') {
      // Windows might be more conservative
      maxConcurrency = Math.min(maxConcurrency * 0.8, 150);
    }
    
    // Ensure reasonable bounds
    return Math.max(20, Math.min(maxConcurrency, 500));
  }
  
  // Test internet speed periodically
  async testInternetSpeed() {
    const now = Date.now();
    if (now - this.config.lastSpeedTest < this.config.speedTestInterval) {
      return this.performanceMetrics.internetSpeed;
    }
    
    try {
      console.log('Testing internet speed...');
      const startTime = performance.now();
      
      // Test with multiple small requests to simulate crawler behavior
      const testUrls = [
        'https://httpbin.org/json',
        'https://jsonplaceholder.typicode.com/posts/1',
        'https://api.github.com/zen',
        'https://httpbin.org/uuid',
        'https://httpbin.org/base64/SFRUUEJJTiBpcyBhd2Vzb21l'
      ];
      
      const promises = testUrls.map(async (url) => {
        const requestStart = performance.now();
        try {
          await axios.get(url, { timeout: 5000 });
          return performance.now() - requestStart;
        } catch (error) {
          return 5000; // Penalty for failed requests
        }
      });
      
      const responseTimes = await Promise.all(promises);
      const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      
      // Estimate speed based on response times
      // Lower response time = higher effective speed for crawler
      let estimatedSpeed;
      if (avgResponseTime < 200) {
        estimatedSpeed = 200; // Very fast
      } else if (avgResponseTime < 500) {
        estimatedSpeed = 150; // Fast
      } else if (avgResponseTime < 1000) {
        estimatedSpeed = 100; // Medium
      } else if (avgResponseTime < 2000) {
        estimatedSpeed = 50; // Slow
      } else {
        estimatedSpeed = 25; // Very slow
      }
      
      this.performanceMetrics.internetSpeed = estimatedSpeed;
      this.performanceMetrics.networkLatency = avgResponseTime;
      this.config.lastSpeedTest = now;
      
      console.log(`Internet speed test complete: ${estimatedSpeed} Mbps equivalent, ${Math.round(avgResponseTime)}ms avg latency`);
      
      return estimatedSpeed;
    } catch (error) {
      console.error('Speed test failed:', error.message);
      // Use conservative estimate on failure
      this.performanceMetrics.internetSpeed = 50;
      this.config.lastSpeedTest = now;
      return 50;
    }
  }
  
  // Monitor system resources
  getSystemLoad() {
    const loadAvg = os.loadavg()[0]; // 1-minute load average
    const cpuUsage = Math.min(loadAvg / this.systemInfo.cpuCores, 1.0);
    
    const memUsage = process.memoryUsage();
    const totalMemory = this.systemInfo.totalMemory;
    const memoryUsage = (memUsage.rss + memUsage.heapUsed) / totalMemory;
    
    this.performanceMetrics.cpuUsage = cpuUsage;
    this.performanceMetrics.memoryUsage = memoryUsage;
    
    return {
      cpuUsage,
      memoryUsage,
      loadAvg
    };
  }
  
  // Calculate optimal concurrency based on current performance
  calculateOptimalConcurrency(activeJobs, recentMetrics) {
    const systemLoad = this.getSystemLoad();
    
    // Base concurrency on system capacity
    let optimalConcurrency = this.config.minConcurrentJobs;
    
    // Factor 1: System Resources (40% weight)
    const resourceScore = (1 - systemLoad.cpuUsage * 0.6 - systemLoad.memoryUsage * 0.4);
    const resourceFactor = Math.max(0.2, Math.min(1.0, resourceScore));
    
    // Factor 2: Network Performance (30% weight)
    const networkScore = Math.min(this.performanceMetrics.internetSpeed / 100, 2.0);
    const latencyPenalty = Math.max(0.5, Math.min(1.0, 1000 / this.performanceMetrics.networkLatency));
    const networkFactor = networkScore * latencyPenalty;
    
    // Factor 3: Current Performance (30% weight)
    const responseTimeScore = Math.max(0.3, Math.min(1.5, this.config.targetResponseTime / this.performanceMetrics.avgResponseTime));
    const successRateScore = Math.max(0.5, this.performanceMetrics.successRate);
    const performanceFactor = (responseTimeScore + successRateScore) / 2;
    
    // Calculate optimal based on weighted factors
    const capacityMultiplier = (resourceFactor * 0.4 + networkFactor * 0.3 + performanceFactor * 0.3);
    optimalConcurrency = Math.round(this.config.maxConcurrentJobs * capacityMultiplier);
    
    // Apply bounds
    optimalConcurrency = Math.max(this.config.minConcurrentJobs, 
                                 Math.min(this.config.maxConcurrentJobs, optimalConcurrency));
    
    // Gradual adjustment to prevent oscillation
    const currentConcurrency = this.currentConcurrency;
    const maxChange = Math.max(2, Math.round(currentConcurrency * 0.2)); // Max 20% change
    
    if (optimalConcurrency > currentConcurrency) {
      optimalConcurrency = Math.min(optimalConcurrency, currentConcurrency + maxChange);
    } else if (optimalConcurrency < currentConcurrency) {
      optimalConcurrency = Math.max(optimalConcurrency, currentConcurrency - maxChange);
    }
    
    this.currentConcurrency = optimalConcurrency;
    
    return {
      recommended: optimalConcurrency,
      factors: {
        resource: resourceFactor,
        network: networkFactor,
        performance: performanceFactor,
        systemLoad: systemLoad
      },
      reasoning: `CPU: ${Math.round(systemLoad.cpuUsage * 100)}%, Mem: ${Math.round(systemLoad.memoryUsage * 100)}%, Speed: ${this.performanceMetrics.internetSpeed}Mbps, Latency: ${Math.round(this.performanceMetrics.networkLatency)}ms`
    };
  }
  
  // Update performance metrics
  updateMetrics(metrics) {
    if (metrics.avgResponseTime !== undefined) {
      // Weighted average with more emphasis on recent data
      this.performanceMetrics.avgResponseTime = 
        (this.performanceMetrics.avgResponseTime * 0.7 + metrics.avgResponseTime * 0.3);
    }
    
    if (metrics.successRate !== undefined) {
      this.performanceMetrics.successRate = 
        (this.performanceMetrics.successRate * 0.8 + metrics.successRate * 0.2);
    }
    
    if (metrics.throughput !== undefined) {
      this.performanceMetrics.throughputHistory.push({
        timestamp: Date.now(),
        value: metrics.throughput
      });
      
      // Keep only last 10 minutes of history
      const cutoff = Date.now() - 600000;
      this.performanceMetrics.throughputHistory = 
        this.performanceMetrics.throughputHistory.filter(entry => entry.timestamp > cutoff);
    }
  }
  
  // Get current optimization recommendation
  getOptimizationRecommendation(queueStatus) {
    // Test internet speed if needed
    if (Date.now() - this.config.lastSpeedTest > this.config.speedTestInterval) {
      setImmediate(() => this.testInternetSpeed()); // Non-blocking
    }
    
    const optimization = this.calculateOptimalConcurrency(
      queueStatus.activeJobs,
      this.performanceMetrics
    );
    
    return {
      currentConcurrency: this.currentConcurrency,
      recommendedConcurrency: optimization.recommended,
      shouldAdjust: optimization.recommended !== queueStatus.maxConcurrentJobs,
      factors: optimization.factors,
      reasoning: optimization.reasoning,
      systemInfo: this.systemInfo,
      performanceMetrics: this.performanceMetrics
    };
  }
  
  // Start monitoring and periodic adjustments
  startMonitoring() {
    // Initial speed test
    setTimeout(() => this.testInternetSpeed(), 1000);
    
    // Periodic system monitoring
    setInterval(() => {
      const systemLoad = this.getSystemLoad();
      
      if (systemLoad.cpuUsage > 0.9 || systemLoad.memoryUsage > 0.9) {
        console.warn(`High system load detected - CPU: ${Math.round(systemLoad.cpuUsage * 100)}%, Memory: ${Math.round(systemLoad.memoryUsage * 100)}%`);
      }
    }, 10000); // Every 10 seconds
    
    // Periodic speed tests
    setInterval(() => {
      this.testInternetSpeed();
    }, this.config.speedTestInterval);
  }
  
  // Get performance report
  getPerformanceReport() {
    const systemLoad = this.getSystemLoad();
    
    return {
      system: {
        ...this.systemInfo,
        currentLoad: systemLoad
      },
      performance: this.performanceMetrics,
      configuration: {
        currentConcurrency: this.currentConcurrency,
        concurrencyRange: `${this.config.minConcurrentJobs}-${this.config.maxConcurrentJobs}`,
        targetResponseTime: this.config.targetResponseTime,
        targetSuccessRate: this.config.targetSuccessRate
      },
      recommendations: {
        status: this.getHealthStatus(),
        suggestions: this.getOptimizationSuggestions()
      }
    };
  }
  
  // Get system health status
  getHealthStatus() {
    const systemLoad = this.getSystemLoad();
    
    if (systemLoad.cpuUsage > 0.8 || systemLoad.memoryUsage > 0.8) {
      return 'overloaded';
    } else if (systemLoad.cpuUsage > 0.6 || systemLoad.memoryUsage > 0.6) {
      return 'high-load';
    } else if (systemLoad.cpuUsage < 0.3 && systemLoad.memoryUsage < 0.3) {
      return 'underutilized';
    } else {
      return 'optimal';
    }
  }
  
  // Get optimization suggestions
  getOptimizationSuggestions() {
    const suggestions = [];
    const systemLoad = this.getSystemLoad();
    
    if (systemLoad.memoryUsage > 0.8) {
      suggestions.push('Consider reducing concurrency or adding more RAM');
    }
    
    if (systemLoad.cpuUsage > 0.8) {
      suggestions.push('CPU is heavily utilized, consider reducing concurrent jobs');
    }
    
    if (this.performanceMetrics.avgResponseTime > this.config.targetResponseTime * 1.5) {
      suggestions.push('High response times detected, consider reducing concurrency or checking network');
    }
    
    if (this.performanceMetrics.successRate < 0.9) {
      suggestions.push('Low success rate, consider reducing concurrency or increasing timeouts');
    }
    
    if (this.performanceMetrics.internetSpeed < 50) {
      suggestions.push('Slow internet detected, reducing concurrency for stability');
    }
    
    if (suggestions.length === 0) {
      suggestions.push('System performing optimally');
    }
    
    return suggestions;
  }
}

module.exports = PerformanceOptimizer;