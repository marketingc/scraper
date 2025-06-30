class SEOReporter {
  constructor() {
    this.report = {};
  }

  generateReport(analysisData) {
    this.report = {
      summary: this.generateSummary(analysisData),
      details: analysisData,
      recommendations: this.generateRecommendations(analysisData),
      score: this.calculateSEOScore(analysisData)
    };
    return this.report;
  }

  generateSummary(data) {
    const statusCode = data.statusCode;
    const statusInfo = data.statusInfo || {};
    const responseTime = statusInfo.responseTime || 0;

    return {
      url: data.url,
      statusCode: data.statusCode,
      statusHealth: this.getStatusHealth(statusCode),
      responseTime: responseTime,
      responseTimeCategory: this.getResponseTimeCategory(responseTime),
      totalIssues: this.countIssues(data),
      seoScore: this.calculateSEOScore(data),
      statusImpact: this.getStatusImpact(statusCode, responseTime)
    };
  }

  generateRecommendations(data) {
    const recommendations = [];

    if (!data.meta.title) {
      recommendations.push({
        type: 'critical',
        issue: 'Missing title tag',
        suggestion: 'Add a descriptive title tag (50-60 characters)'
      });
    } else if (data.meta.title.length > 60) {
      recommendations.push({
        type: 'warning',
        issue: 'Title too long',
        suggestion: `Title is ${data.meta.title.length} characters. Keep it under 60 characters.`
      });
    }

    if (!data.meta.description) {
      recommendations.push({
        type: 'critical',
        issue: 'Missing meta description',
        suggestion: 'Add a meta description (150-160 characters)'
      });
    } else if (data.meta.description.length > 160) {
      recommendations.push({
        type: 'warning',
        issue: 'Meta description too long',
        suggestion: `Description is ${data.meta.description.length} characters. Keep it under 160 characters.`
      });
    }

    if (!data.technical.hasH1) {
      recommendations.push({
        type: 'critical',
        issue: 'Missing H1 tag',
        suggestion: 'Add exactly one H1 tag to the page'
      });
    } else if (data.technical.h1Count > 1) {
      recommendations.push({
        type: 'warning',
        issue: 'Multiple H1 tags',
        suggestion: `Found ${data.technical.h1Count} H1 tags. Use only one H1 per page.`
      });
    }

    const imagesWithoutAlt = data.images.filter(img => img.isEmpty);
    if (imagesWithoutAlt.length > 0) {
      recommendations.push({
        type: 'warning',
        issue: 'Images missing alt text',
        suggestion: `${imagesWithoutAlt.length} images are missing alt text. Add descriptive alt attributes.`,
        details: {
          type: 'images_missing_alt',
          count: imagesWithoutAlt.length,
          images: imagesWithoutAlt.map(img => ({
            src: img.originalSrc,
            fullUrl: img.src,
            context: img.context.nearbyText || 'No context available',
            parentElement: img.context.parentTag,
            className: img.className,
            htmlSnippet: img.context.htmlSnippet,
            suggestedAlt: this.generateAltSuggestion(img)
          }))
        }
      });
    }

    if (!data.technical.hasCanonical) {
      recommendations.push({
        type: 'info',
        issue: 'Missing canonical URL',
        suggestion: 'Consider adding a canonical URL to prevent duplicate content issues'
      });
    }

    // Schema validation recommendations
    this.addSchemaRecommendations(recommendations, data.schema);

    // Status code recommendations
    this.addStatusCodeRecommendations(data, recommendations);

    return recommendations;
  }

  calculateSEOScore(data) {
    let score = 100;

    // Meta and content scoring
    if (!data.meta.title) score -= 20;
    else if (data.meta.title.length > 60) score -= 10;

    if (!data.meta.description) score -= 15;
    else if (data.meta.description.length > 160) score -= 8;

    if (!data.technical.hasH1) score -= 15;
    else if (data.technical.h1Count > 1) score -= 8;

    const imagesWithoutAlt = data.images.filter(img => img.isEmpty);
    score -= Math.min(imagesWithoutAlt.length * 2, 20);

    if (!data.technical.hasCanonical) score -= 5;

    // Status code scoring
    const statusCode = data.statusCode;
    const statusInfo = data.statusInfo || {};
    const responseTime = statusInfo.responseTime || 0;

    // Major deductions for 4xx/5xx errors
    if (statusCode >= 400 && statusCode < 500) {
      score -= 25; // Major deduction for client errors
    } else if (statusCode >= 500) {
      score -= 35; // Critical deduction for server errors
    }

    // Smaller deductions for redirects
    if (statusCode >= 300 && statusCode < 400) {
      score -= 10; // Moderate deduction for redirects
    }

    // Response time deductions
    if (responseTime > 5000) {
      score -= 15; // Major deduction for very slow responses
    } else if (responseTime > 3000) {
      score -= 10; // Moderate deduction for slow responses
    } else if (responseTime > 1000) {
      score -= 5; // Small deduction for somewhat slow responses
    }

    // HTTPS bonus/penalty
    if (data.url && data.url.startsWith('http://')) {
      score -= 8; // Deduction for non-HTTPS
    }

    // SSL Certificate Issues penalty
    if (data.statusInfo && data.statusInfo.details && data.statusInfo.details.ssl && data.statusInfo.details.ssl.sslValidationFailed) {
      score -= 12; // Higher penalty for SSL certificate issues (worse than no HTTPS)
    }

    return Math.max(0, score);
  }

  // New method to provide detailed scoring breakdown
  calculateDetailedSEOScore(data) {
    const breakdown = {
      baseScore: 100,
      finalScore: 0,
      totalPenalties: 0,
      sections: {
        metaData: {
          maxScore: 43,
          currentScore: 43,
          penalties: [],
          items: []
        },
        contentStructure: {
          maxScore: 28,
          currentScore: 28,
          penalties: [],
          items: []
        },
        imageOptimization: {
          maxScore: 20,
          currentScore: 20,
          penalties: [],
          items: []
        },
        technicalPerformance: {
          maxScore: 50,
          currentScore: 50,
          penalties: [],
          items: []
        },
        schemaMarkup: {
          maxScore: 25,
          currentScore: 25,
          penalties: [],
          items: []
        },
        progressiveWebApp: {
          maxScore: 15,
          currentScore: 15,
          penalties: [],
          items: []
        }
      }
    };

    // Meta Data Section (43 points max penalty)
    const metaSection = breakdown.sections.metaData;
    
    // Title (20 points max penalty)
    if (!data.meta.title) {
      metaSection.penalties.push({ issue: 'Missing Title Tag', penalty: 20, reason: 'No <title> element found' });
      metaSection.currentScore -= 20;
    } else if (data.meta.title.length > 60) {
      metaSection.penalties.push({ issue: 'Title Too Long', penalty: 10, reason: `Title is ${data.meta.title.length} characters (recommended: ≤60)` });
      metaSection.currentScore -= 10;
    } else {
      metaSection.items.push({ item: 'Title Tag', status: 'good', details: `Length: ${data.meta.title.length} characters` });
    }

    // Description (15 points max penalty)
    if (!data.meta.description) {
      metaSection.penalties.push({ issue: 'Missing Meta Description', penalty: 15, reason: 'No meta description tag found' });
      metaSection.currentScore -= 15;
    } else if (data.meta.description.length > 160) {
      metaSection.penalties.push({ issue: 'Description Too Long', penalty: 8, reason: `Description is ${data.meta.description.length} characters (recommended: ≤160)` });
      metaSection.currentScore -= 8;
    } else {
      metaSection.items.push({ item: 'Meta Description', status: 'good', details: `Length: ${data.meta.description.length} characters` });
    }

    // Content Structure Section (28 points max penalty)
    const contentSection = breakdown.sections.contentStructure;
    
    // H1 Tag (15 points max penalty)
    if (!data.technical.hasH1) {
      contentSection.penalties.push({ issue: 'Missing H1 Tag', penalty: 15, reason: 'No main heading (H1) found on the page' });
      contentSection.currentScore -= 15;
    } else if (data.technical.h1Count > 1) {
      contentSection.penalties.push({ issue: 'Multiple H1 Tags', penalty: 8, reason: `Found ${data.technical.h1Count} H1 tags (should be unique)` });
      contentSection.currentScore -= 8;
    } else {
      contentSection.items.push({ item: 'H1 Tag', status: 'good', details: 'Single H1 tag found' });
    }

    // Canonical URL (5 points max penalty)
    if (!data.technical.hasCanonical) {
      contentSection.penalties.push({ issue: 'Missing Canonical URL', penalty: 5, reason: 'No canonical link tag found' });
      contentSection.currentScore -= 5;
    } else {
      contentSection.items.push({ item: 'Canonical URL', status: 'good', details: 'Canonical link tag present' });
    }

    // Image Optimization Section (20 points max penalty)
    const imageSection = breakdown.sections.imageOptimization;
    const imagesWithoutAlt = data.images.filter(img => img.isEmpty);
    const imagePenalty = Math.min(imagesWithoutAlt.length * 2, 20);
    
    if (imagePenalty > 0) {
      imageSection.penalties.push({ 
        issue: 'Missing Alt Text', 
        penalty: imagePenalty, 
        reason: `${imagesWithoutAlt.length} images without alt text (${imagePenalty} points deducted)` 
      });
      imageSection.currentScore -= imagePenalty;
    } else {
      imageSection.items.push({ 
        item: 'Image Alt Text', 
        status: 'good', 
        details: `All ${data.images.length} images have alt text` 
      });
    }

    // Technical Performance Section (50+ points max penalty)
    const techSection = breakdown.sections.technicalPerformance;
    const statusCode = data.statusCode;
    const statusInfo = data.statusInfo || {};
    const responseTime = statusInfo.responseTime || 0;

    // Status Code Analysis (35 points max penalty)
    if (statusCode >= 500) {
      techSection.penalties.push({ issue: 'Server Error (5xx)', penalty: 35, reason: `HTTP ${statusCode} - Server error detected` });
      techSection.currentScore -= 35;
    } else if (statusCode >= 400) {
      techSection.penalties.push({ issue: 'Client Error (4xx)', penalty: 25, reason: `HTTP ${statusCode} - Client error detected` });
      techSection.currentScore -= 25;
    } else if (statusCode >= 300) {
      techSection.penalties.push({ issue: 'Redirect (3xx)', penalty: 10, reason: `HTTP ${statusCode} - Redirect detected` });
      techSection.currentScore -= 10;
    } else if (statusCode >= 200 && statusCode < 300) {
      techSection.items.push({ item: 'HTTP Status', status: 'good', details: `HTTP ${statusCode} - Success` });
    }

    // Response Time Analysis (15 points max penalty)
    if (responseTime > 5000) {
      techSection.penalties.push({ issue: 'Very Slow Response', penalty: 15, reason: `${(responseTime/1000).toFixed(1)}s response time (>5s is very slow)` });
      techSection.currentScore -= 15;
    } else if (responseTime > 3000) {
      techSection.penalties.push({ issue: 'Slow Response', penalty: 10, reason: `${(responseTime/1000).toFixed(1)}s response time (3-5s is slow)` });
      techSection.currentScore -= 10;
    } else if (responseTime > 1000) {
      techSection.penalties.push({ issue: 'Moderate Response Time', penalty: 5, reason: `${(responseTime/1000).toFixed(1)}s response time (1-3s is moderate)` });
      techSection.currentScore -= 5;
    } else {
      techSection.items.push({ item: 'Response Time', status: 'good', details: `${(responseTime/1000).toFixed(1)}s (fast)` });
    }

    // HTTPS Analysis (8 points max penalty)
    if (data.url && data.url.startsWith('http://')) {
      techSection.penalties.push({ issue: 'Non-HTTPS URL', penalty: 8, reason: 'Using HTTP instead of secure HTTPS protocol' });
      techSection.currentScore -= 8;
    } else {
      techSection.items.push({ item: 'HTTPS Protocol', status: 'good', details: 'Secure HTTPS connection' });
    }

    // SSL Certificate Analysis (12 points max penalty)
    if (data.statusInfo && data.statusInfo.details && data.statusInfo.details.ssl && data.statusInfo.details.ssl.sslValidationFailed) {
      techSection.penalties.push({ issue: 'SSL Certificate Issues', penalty: 12, reason: 'SSL certificate validation failed' });
      techSection.currentScore -= 12;
    } else if (data.url && data.url.startsWith('https://')) {
      techSection.items.push({ item: 'SSL Certificate', status: 'good', details: 'Valid SSL certificate' });
    }

    // Schema Markup Section (25 points max penalty)
    const schemaSection = breakdown.sections.schemaMarkup;
    const schema = data.schema || {};
    const schemaSummary = schema.summary || {};
    
    // Basic Schema Presence (10 points max penalty)
    if (!schema.jsonLd || schema.jsonLd.length === 0) {
      schemaSection.penalties.push({ 
        issue: 'No Structured Data Found', 
        penalty: 10, 
        reason: 'No JSON-LD, Microdata, or RDFa structured data detected' 
      });
      schemaSection.currentScore -= 10;
    } else {
      schemaSection.items.push({ 
        item: 'Structured Data Present', 
        status: 'good', 
        details: `${schema.jsonLd.length} JSON-LD schemas found` 
      });
    }

    // Organization Schema (5 points max penalty)
    if (!schemaSummary.hasOrganization) {
      schemaSection.penalties.push({ 
        issue: 'Missing Organization Schema', 
        penalty: 5, 
        reason: 'Organization schema helps establish business identity' 
      });
      schemaSection.currentScore -= 5;
    } else {
      schemaSection.items.push({ 
        item: 'Organization Schema', 
        status: 'good', 
        details: 'Organization structured data found' 
      });
    }

    // Website Schema (3 points max penalty)
    if (!schemaSummary.hasWebsite) {
      schemaSection.penalties.push({ 
        issue: 'Missing Website Schema', 
        penalty: 3, 
        reason: 'Website schema helps search engines understand site structure' 
      });
      schemaSection.currentScore -= 3;
    } else {
      schemaSection.items.push({ 
        item: 'Website Schema', 
        status: 'good', 
        details: 'Website structured data found' 
      });
    }

    // Breadcrumb Schema (4 points max penalty)
    if (!schemaSummary.hasBreadcrumb) {
      schemaSection.penalties.push({ 
        issue: 'Missing Breadcrumb Schema', 
        penalty: 4, 
        reason: 'Breadcrumb schema improves navigation display in search results' 
      });
      schemaSection.currentScore -= 4;
    } else {
      schemaSection.items.push({ 
        item: 'Breadcrumb Schema', 
        status: 'good', 
        details: 'Breadcrumb structured data found' 
      });
    }

    // Schema Validation Errors (3 points max penalty)
    if (schema.errors && schema.errors.length > 0) {
      schemaSection.penalties.push({ 
        issue: 'Schema Validation Errors', 
        penalty: 3, 
        reason: `${schema.errors.length} validation errors found in structured data` 
      });
      schemaSection.currentScore -= 3;
    } else if (schema.jsonLd && schema.jsonLd.length > 0) {
      schemaSection.items.push({ 
        item: 'Schema Validation', 
        status: 'good', 
        details: 'No validation errors detected' 
      });
    }

    // Progressive Web App Section (15 points max penalty)
    const pwaSection = breakdown.sections.progressiveWebApp;
    const pwa = data.pwa || {};
    
    // PWA Status - Binary indicator based on manifest presence
    pwaSection.hasPWA = !!pwa.hasManifest;
    pwaSection.manifestUrl = pwa.manifestUrl || null;
    
    // Web App Manifest (8 points max penalty)
    if (!pwa.hasManifest) {
      pwaSection.penalties.push({ 
        issue: 'Missing Web App Manifest', 
        penalty: 8, 
        reason: 'Web app manifest enables app-like installation and behavior' 
      });
      pwaSection.currentScore -= 8;
    } else {
      pwaSection.items.push({ 
        item: 'Web App Manifest', 
        status: 'good', 
        details: 'Manifest file detected' 
      });
    }

    // Service Worker (5 points max penalty)
    if (!pwa.hasServiceWorker) {
      pwaSection.penalties.push({ 
        issue: 'Missing Service Worker', 
        penalty: 5, 
        reason: 'Service worker enables offline functionality and push notifications' 
      });
      pwaSection.currentScore -= 5;
    } else {
      pwaSection.items.push({ 
        item: 'Service Worker', 
        status: 'good', 
        details: 'Service worker detected' 
      });
    }

    // Apple Touch Icons (2 points max penalty)
    if (!pwa.metaTags || !pwa.metaTags.appleTouchIcons || pwa.metaTags.appleTouchIcons.length === 0) {
      pwaSection.penalties.push({ 
        issue: 'Missing Apple Touch Icons', 
        penalty: 2, 
        reason: 'Apple touch icons improve iOS home screen appearance' 
      });
      pwaSection.currentScore -= 2;
    } else {
      pwaSection.items.push({ 
        item: 'Apple Touch Icons', 
        status: 'good', 
        details: `${pwa.metaTags.appleTouchIcons.length} icons found` 
      });
    }

    // Calculate totals
    breakdown.totalPenalties = Object.values(breakdown.sections).reduce((total, section) => {
      return total + section.penalties.reduce((sectionTotal, penalty) => sectionTotal + penalty.penalty, 0);
    }, 0);

    breakdown.finalScore = Math.max(0, breakdown.baseScore - breakdown.totalPenalties);

    return breakdown;
  }

  countIssues(data) {
    let issues = 0;

    // Content issues
    if (!data.meta.title || data.meta.title.length > 60) issues++;
    if (!data.meta.description || data.meta.description.length > 160) issues++;
    if (!data.technical.hasH1 || data.technical.h1Count > 1) issues++;
    if (!data.technical.hasCanonical) issues++;

    const imagesWithoutAlt = data.images.filter(img => img.isEmpty);
    if (imagesWithoutAlt.length > 0) issues++;

    // Status code issues
    const statusCode = data.statusCode;
    const statusInfo = data.statusInfo || {};
    const responseTime = statusInfo.responseTime || 0;

    if (statusCode >= 400) issues++; // 4xx/5xx errors
    if (statusCode >= 300 && statusCode < 400) issues++; // Redirects
    if (responseTime > 3000) issues++; // Slow response time
    if (data.url && data.url.startsWith('http://')) issues++; // Non-HTTPS

    return issues;
  }

  formatConsoleReport(report) {
    const output = [];
    
    output.push('='.repeat(60));
    output.push(`SEO ANALYSIS REPORT`);
    output.push('='.repeat(60));
    output.push(`URL: ${report.summary.url}`);
    output.push(`Status: ${report.summary.statusCode} (${report.summary.statusHealth})`);
    output.push(`Response Time: ${(report.summary.responseTime / 1000).toFixed(1)}s (${report.summary.responseTimeCategory})`);
    output.push(`SEO Score: ${report.summary.seoScore}/100`);
    output.push(`Issues Found: ${report.summary.totalIssues}`);
    if (report.summary.statusImpact.level !== 'none') {
      output.push(`Status Impact: ${report.summary.statusImpact.level.toUpperCase()} - ${report.summary.statusImpact.description}`);
    }
    output.push('');

    output.push('META DATA:');
    output.push('-'.repeat(40));
    output.push(`Title: ${report.details.meta.title || 'MISSING'}`);
    output.push(`  Length: ${report.details.meta.title ? report.details.meta.title.length : 0} characters`);
    output.push(`Description: ${report.details.meta.description || 'MISSING'}`);
    output.push(`  Length: ${report.details.meta.description ? report.details.meta.description.length : 0} characters`);
    output.push(`Keywords: ${report.details.meta.keywords || 'NONE'}`);
    output.push('');

    output.push('HEADINGS:');
    output.push('-'.repeat(40));
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
      const count = report.details.headings[tag].length;
      if (count > 0) {
        output.push(`${tag.toUpperCase()}: ${count} found`);
        report.details.headings[tag].slice(0, 3).forEach(heading => {
          output.push(`  - ${heading.substring(0, 80)}${heading.length > 80 ? '...' : ''}`);
        });
      }
    });
    output.push('');

    output.push('IMAGES:');
    output.push('-'.repeat(40));
    output.push(`Total Images: ${report.details.images.length}`);
    const imagesWithoutAlt = report.details.images.filter(img => img.isEmpty);
    output.push(`Without Alt Text: ${imagesWithoutAlt.length}`);
    output.push('');

    output.push('LINKS:');
    output.push('-'.repeat(40));
    output.push(`Internal Links: ${report.details.links.internal.length}`);
    output.push(`External Links: ${report.details.links.external.length}`);
    output.push('');

    output.push('CONTENT:');
    output.push('-'.repeat(40));
    output.push(`Word Count: ${report.details.content.wordCount}`);
    output.push(`Character Count: ${report.details.content.characterCount}`);
    output.push('');

    if (report.recommendations.length > 0) {
      output.push('RECOMMENDATIONS:');
      output.push('-'.repeat(40));
      report.recommendations.forEach((rec, index) => {
        const priority = rec.type === 'critical' ? '🔴' : rec.type === 'warning' ? '🟡' : '🔵';
        output.push(`${index + 1}. ${priority} ${rec.issue}`);
        output.push(`   ${rec.suggestion}`);
        output.push('');
      });
    }

    output.push('='.repeat(60));
    
    return output.join('\n');
  }

  generateAltSuggestion(img) {
    const src = img.originalSrc.toLowerCase();
    const context = img.context.nearbyText.toLowerCase();
    const className = img.className.toLowerCase();
    
    // Try to suggest based on filename
    if (src.includes('logo')) return 'Company logo';
    if (src.includes('banner')) return 'Banner image';
    if (src.includes('hero')) return 'Hero section image';
    if (src.includes('product')) return 'Product image';
    if (src.includes('avatar') || src.includes('profile')) return 'User profile picture';
    if (src.includes('icon')) return 'Icon';
    
    // Try to suggest based on context
    if (context.includes('product') || context.includes('buy')) return 'Product image';
    if (context.includes('team') || context.includes('staff')) return 'Team member photo';
    if (context.includes('service')) return 'Service illustration';
    if (context.includes('about')) return 'About us image';
    
    // Try to suggest based on class name
    if (className.includes('logo')) return 'Logo';
    if (className.includes('icon')) return 'Icon';
    if (className.includes('banner')) return 'Banner';
    
    return 'Descriptive alt text needed';
  }

  generateDetailedReport(analysisData) {
    const report = this.generateReport(analysisData);
    
    // Add detailed sections
    report.detailedAnalysis = {
      imageIssues: this.analyzeImageIssues(analysisData.images),
      metaIssues: this.analyzeMetaIssues(analysisData.meta),
      headingIssues: this.analyzeHeadingIssues(analysisData.headings),
      technicalIssues: this.analyzeTechnicalIssues(analysisData)
    };

    // Add detailed SEO scoring breakdown
    report.scoreBreakdown = this.calculateDetailedSEOScore(analysisData);
    
    // Ensure schema data is properly included
    if (analysisData.schema) {
      report.details.schema = analysisData.schema;
    } else {
      // Provide fallback schema structure
      report.details.schema = {
        summary: {
          totalSchemas: 0,
          hasOrganization: false,
          hasWebsite: false,
          hasProduct: false,
          hasArticle: false,
          hasBreadcrumb: false,
          hasLocalBusiness: false
        },
        errors: [],
        jsonLd: [],
        microdata: [],
        rdfa: []
      };
    }
    
    return report;
  }

  analyzeImageIssues(images) {
    const issues = {
      missingAlt: images.filter(img => img.isEmpty),
      longAlt: images.filter(img => img.altLength > 125),
      shortAlt: images.filter(img => img.altLength > 0 && img.altLength < 10),
      noTitle: images.filter(img => !img.title && !img.isEmpty),
      largeImages: images.filter(img => img.width && parseInt(img.width) > 1200)
    };
    
    return issues;
  }

  analyzeMetaIssues(meta) {
    const issues = {};
    
    if (!meta.title) issues.missingTitle = true;
    if (meta.titleLength > 60) issues.titleTooLong = { length: meta.titleLength, recommended: 60 };
    if (meta.titleLength < 30) issues.titleTooShort = { length: meta.titleLength, recommended: 30 };
    
    if (!meta.description) issues.missingDescription = true;
    if (meta.descriptionLength > 160) issues.descriptionTooLong = { length: meta.descriptionLength, recommended: 160 };
    if (meta.descriptionLength < 120) issues.descriptionTooShort = { length: meta.descriptionLength, recommended: 120 };
    
    if (!meta.ogTitle) issues.missingOgTitle = true;
    if (!meta.ogDescription) issues.missingOgDescription = true;
    if (!meta.ogImage) issues.missingOgImage = true;
    
    if (!meta.viewport) issues.missingViewport = true;
    if (!meta.lang) issues.missingLang = true;
    
    return issues;
  }

  analyzeHeadingIssues(headings) {
    const issues = {};
    
    if (headings.h1.length === 0) issues.missingH1 = true;
    if (headings.h1.length > 1) issues.multipleH1 = { count: headings.h1.length };
    
    // Check heading hierarchy
    const hasH2 = headings.h2.length > 0;
    const hasH3 = headings.h3.length > 0;
    const hasH4 = headings.h4.length > 0;
    
    if (hasH3 && !hasH2) issues.skippedH2 = true;
    if (hasH4 && !hasH3) issues.skippedH3 = true;
    
    return issues;
  }

  analyzeTechnicalIssues(data) {
    const issues = {};
    
    if (!data.technical.hasCanonical) issues.missingCanonical = true;
    if (!data.meta.robots) issues.missingRobots = true;
    if (data.content.wordCount < 300) issues.lowWordCount = { count: data.content.wordCount, recommended: 300 };
    
    return issues;
  }

  addSchemaRecommendations(recommendations, schemaData) {
    if (!schemaData || !schemaData.summary || schemaData.summary.totalSchemas === 0) {
      recommendations.push({
        type: 'warning',
        issue: 'No structured data found',
        suggestion: 'Add Schema.org structured data to help search engines understand your content better.',
        details: {
          type: 'missing_schema',
          recommendedSchemas: this.getRecommendedSchemas(),
          examples: this.getSchemaExamples()
        }
      });
      return;
    }

    // Check for schema errors
    if (schemaData.errors.length > 0) {
      recommendations.push({
        type: 'critical',
        issue: 'Structured data errors',
        suggestion: `${schemaData.errors.length} structured data parsing errors found. Fix these to ensure proper schema validation.`,
        details: {
          type: 'schema_errors',
          errors: schemaData.errors
        }
      });
    }

    // Check for invalid schemas with detailed analysis
    const invalidSchemas = schemaData.jsonLd.filter(schema => !schema.valid || schema.errors.length > 0);
    if (invalidSchemas.length > 0) {
      recommendations.push({
        type: 'warning',
        issue: 'Invalid structured data',
        suggestion: `${invalidSchemas.length} schema(s) have validation errors. Fix these to improve rich snippet eligibility.`,
        details: {
          type: 'invalid_schemas',
          schemas: invalidSchemas.map(schema => ({
            type: schema.type,
            errors: schema.errors,
            data: schema.data,
            detailedValidation: schema.detailedValidation,
            fixes: this.generateSchemaFixes(schema)
          }))
        }
      });
    }

    // Add detailed schema analysis for existing schemas
    const validSchemas = schemaData.jsonLd.filter(schema => schema.valid && schema.detailedValidation);
    if (validSchemas.length > 0) {
      validSchemas.forEach(schema => {
        const validation = schema.detailedValidation;
        if (validation.completeness < 100) {
          recommendations.push({
            type: 'info',
            issue: `${schema.type} schema can be improved`,
            suggestion: `Your ${schema.type} schema is ${validation.completeness}% complete (Grade: ${validation.grade}). Add missing properties to enhance rich snippet eligibility.`,
            details: {
              type: 'schema_improvement',
              schemaType: schema.type,
              validation: validation,
              missingProperties: validation.recommendations
            }
          });
        }
      });
    }

    // Check for missing essential schemas
    const missingSchemas = this.getMissingEssentialSchemas(schemaData.summary);
    if (missingSchemas.length > 0) {
      recommendations.push({
        type: 'info',
        issue: 'Missing recommended structured data',
        suggestion: `Consider adding ${missingSchemas.join(', ')} schema(s) to enhance your search presence.`,
        details: {
          type: 'missing_recommended_schemas',
          missing: missingSchemas,
          examples: this.getSchemaExamplesForTypes(missingSchemas)
        }
      });
    }
  }

  getRecommendedSchemas() {
    return [
      {
        type: 'Organization',
        description: 'Information about your business/organization',
        priority: 'high'
      },
      {
        type: 'WebSite',
        description: 'Basic website information and search functionality',
        priority: 'high'
      },
      {
        type: 'BreadcrumbList',
        description: 'Navigation breadcrumbs for better site structure',
        priority: 'medium'
      }
    ];
  }

  getSchemaExamples() {
    return {
      Organization: {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        'name': 'Your Company Name',
        'url': 'https://www.yourwebsite.com',
        'logo': 'https://www.yourwebsite.com/logo.png',
        'contactPoint': {
          '@type': 'ContactPoint',
          'telephone': '+1-555-555-5555',
          'contactType': 'customer service'
        }
      },
      WebSite: {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        'name': 'Your Website Name',
        'url': 'https://www.yourwebsite.com',
        'potentialAction': {
          '@type': 'SearchAction',
          'target': 'https://www.yourwebsite.com/search?q={search_term_string}',
          'query-input': 'required name=search_term_string'
        }
      }
    };
  }

  getMissingEssentialSchemas(summary) {
    const missing = [];
    
    if (!summary.hasOrganization) missing.push('Organization');
    if (!summary.hasWebsite) missing.push('WebSite');
    if (!summary.hasBreadcrumb) missing.push('BreadcrumbList');
    
    return missing;
  }

  getSchemaExamplesForTypes(types) {
    const examples = {};
    const allExamples = this.getSchemaExamples();
    
    types.forEach(type => {
      if (allExamples[type]) {
        examples[type] = allExamples[type];
      }
    });
    
    return examples;
  }

  generateSchemaFixes(schema) {
    const fixes = [];
    const type = schema.type;
    
    schema.errors.forEach(error => {
      if (error.includes('Missing required property: name')) {
        fixes.push({
          property: 'name',
          suggestion: 'Add a name property with your organization/product name',
          example: '"name": "Your Company Name"'
        });
      }
      
      if (error.includes('Missing required property: url')) {
        fixes.push({
          property: 'url',
          suggestion: 'Add a url property with your website URL',
          example: '"url": "https://www.yourwebsite.com"'
        });
      }
      
      if (error.includes('Missing required property: description')) {
        fixes.push({
          property: 'description',
          suggestion: 'Add a description property with detailed information',
          example: '"description": "Detailed description of your product/service"'
        });
      }
      
      if (error.includes('Missing recommended property: logo')) {
        fixes.push({
          property: 'logo',
          suggestion: 'Add a logo property with your company logo URL',
          example: '"logo": "https://www.yourwebsite.com/logo.png"'
        });
      }
    });
    
    return fixes;
  }

  addStatusCodeRecommendations(data, recommendations) {
    const statusCode = data.statusCode;
    const statusInfo = data.statusInfo || {};
    const responseTime = statusInfo.responseTime || 0;

    // Critical recommendations for 4xx/5xx errors
    if (statusCode >= 400 && statusCode < 500) {
      recommendations.push({
        type: 'critical',
        issue: `Client error: ${statusCode}`,
        suggestion: this.getClientErrorAdvice(statusCode),
        details: {
          type: 'status_code_error',
          statusCode: statusCode,
          category: 'client_error',
          seoImpact: 'High - Search engines cannot index pages with 4xx errors',
          urgency: 'Immediate action required'
        }
      });
    } else if (statusCode >= 500) {
      recommendations.push({
        type: 'critical',
        issue: `Server error: ${statusCode}`,
        suggestion: this.getServerErrorAdvice(statusCode),
        details: {
          type: 'status_code_error',
          statusCode: statusCode,
          category: 'server_error',
          seoImpact: 'Critical - Search engines will deindex pages with persistent 5xx errors',
          urgency: 'Immediate action required'
        }
      });
    }

    // Warnings for redirects (3xx codes)
    if (statusCode >= 300 && statusCode < 400) {
      recommendations.push({
        type: 'warning',
        issue: `Redirect detected: ${statusCode}`,
        suggestion: this.getRedirectAdvice(statusCode),
        details: {
          type: 'redirect_warning',
          statusCode: statusCode,
          category: 'redirect',
          seoImpact: 'Medium - Redirects can dilute link equity and slow page loading',
          recommendation: 'Consider serving content directly if possible'
        }
      });
    }

    // Response time recommendations
    if (responseTime > 3000) {
      const severity = responseTime > 5000 ? 'critical' : 'warning';
      recommendations.push({
        type: severity,
        issue: 'Slow response time',
        suggestion: `Page response time is ${(responseTime / 1000).toFixed(1)}s. Optimize server performance to improve user experience and SEO rankings.`,
        details: {
          type: 'performance_issue',
          responseTime: responseTime,
          category: 'performance',
          seoImpact: 'High - Page speed is a ranking factor and affects user experience',
          recommendations: this.getPerformanceRecommendations(responseTime)
        }
      });
    } else if (responseTime > 1000) {
      recommendations.push({
        type: 'info',
        issue: 'Response time could be improved',
        suggestion: `Page response time is ${(responseTime / 1000).toFixed(1)}s. Consider optimizing for better performance.`,
        details: {
          type: 'performance_suggestion',
          responseTime: responseTime,
          category: 'performance',
          seoImpact: 'Low to Medium - Faster pages provide better user experience'
        }
      });
    }

    // SSL/HTTPS recommendations
    if (data.url && data.url.startsWith('http://')) {
      recommendations.push({
        type: 'warning',
        issue: 'Non-HTTPS URL',
        suggestion: 'Implement HTTPS to improve security and SEO rankings. Google favors secure sites.',
        details: {
          type: 'security_issue',
          category: 'https',
          seoImpact: 'Medium - HTTPS is a ranking signal and builds user trust',
          urgency: 'Recommended'
        }
      });
    }

    // SSL Certificate Issues
    if (statusInfo.details && statusInfo.details.ssl && statusInfo.details.ssl.sslValidationFailed) {
      const sslError = statusInfo.details.ssl.sslError;
      let sslAdvice = 'Fix SSL certificate issues to ensure secure connections and user trust.';
      let urgency = 'High priority';
      
      // Provide specific advice based on SSL error type
      switch (sslError) {
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
          sslAdvice = 'SSL certificate chain is incomplete. Ensure all intermediate certificates are properly installed on your server.';
          break;
        case 'CERT_UNTRUSTED':
          sslAdvice = 'SSL certificate is not trusted. Install a certificate from a recognized Certificate Authority (CA).';
          break;
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          sslAdvice = 'Self-signed certificate detected. Replace with a certificate from a trusted Certificate Authority for production use.';
          break;
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
          sslAdvice = 'SSL certificate signature cannot be verified. Check certificate installation and chain configuration.';
          break;
      }
      
      recommendations.push({
        type: 'critical',
        issue: 'SSL Certificate Error',
        suggestion: sslAdvice,
        details: {
          type: 'ssl_error',
          sslError: sslError,
          category: 'security',
          seoImpact: 'High - SSL issues affect user trust, security warnings, and can negatively impact search rankings',
          urgency: urgency,
          technicalNote: 'Site was accessible but with SSL certificate validation bypassed'
        }
      });
    }
  }

  getClientErrorAdvice(statusCode) {
    const advice = {
      400: 'Fix malformed request syntax. Check URL parameters and request format.',
      401: 'Authentication required. Ensure proper login credentials or API keys.',
      403: 'Access forbidden. Check file permissions and server configuration.',
      404: 'Page not found. Implement proper redirects or restore missing content.',
      405: 'Method not allowed. Check if the HTTP method is supported.',
      410: 'Content permanently removed. Implement 301 redirects to relevant pages.',
      429: 'Too many requests. Implement rate limiting and caching strategies.'
    };
    
    return advice[statusCode] || `Client error ${statusCode}. Review server logs and fix the underlying issue to prevent search engine indexing problems.`;
  }

  getServerErrorAdvice(statusCode) {
    const advice = {
      500: 'Internal server error. Check server logs, fix code issues, and monitor server resources.',
      501: 'Feature not implemented. Complete the implementation or return appropriate response.',
      502: 'Bad gateway. Check upstream server connectivity and configuration.',
      503: 'Service unavailable. Resolve server overload or maintenance issues.',
      504: 'Gateway timeout. Optimize server response times and check network connectivity.'
    };
    
    return advice[statusCode] || `Server error ${statusCode}. Critical issue requiring immediate attention to prevent search engine deindexing.`;
  }

  getRedirectAdvice(statusCode) {
    const advice = {
      301: 'Permanent redirect detected. Good for SEO but consider serving content directly if this is the final destination.',
      302: 'Temporary redirect detected. Use 301 redirects for permanent moves to preserve SEO value.',
      307: 'Temporary redirect (method preserved). Consider using 301 for permanent moves.',
      308: 'Permanent redirect (method preserved). Good for SEO but consider direct serving if possible.'
    };
    
    return advice[statusCode] || `Redirect ${statusCode} detected. Minimize redirect chains to improve page load speed and preserve SEO value.`;
  }

  getPerformanceRecommendations(responseTime) {
    const recommendations = [
      'Implement server-side caching (Redis, Memcached)',
      'Optimize database queries and add proper indexing',
      'Use a Content Delivery Network (CDN)',
      'Compress responses with gzip/brotli',
      'Optimize images and reduce file sizes',
      'Minimize HTTP requests and concatenate resources'
    ];

    if (responseTime > 5000) {
      recommendations.unshift('Immediate server optimization required');
      recommendations.push('Consider upgrading server resources');
    }

    return recommendations;
  }

  getStatusHealth(statusCode) {
    if (statusCode >= 200 && statusCode < 300) {
      return 'healthy';
    } else if (statusCode >= 300 && statusCode < 400) {
      return 'redirect';
    } else if (statusCode >= 400 && statusCode < 500) {
      return 'client_error';
    } else if (statusCode >= 500) {
      return 'server_error';
    } else {
      return 'unknown';
    }
  }

  getResponseTimeCategory(responseTime) {
    if (responseTime < 500) {
      return 'fast';
    } else if (responseTime < 1000) {
      return 'good';
    } else if (responseTime < 3000) {
      return 'slow';
    } else if (responseTime < 5000) {
      return 'very_slow';
    } else {
      return 'critical';
    }
  }

  getStatusImpact(statusCode, responseTime) {
    let impact = 'none';
    let severity = 0;

    // Status code impact
    if (statusCode >= 400 && statusCode < 500) {
      impact = 'high';
      severity = 3;
    } else if (statusCode >= 500) {
      impact = 'critical';
      severity = 4;
    } else if (statusCode >= 300 && statusCode < 400) {
      impact = 'medium';
      severity = 2;
    }

    // Response time impact
    if (responseTime > 5000) {
      if (severity < 3) {
        impact = 'high';
        severity = 3;
      }
    } else if (responseTime > 3000) {
      if (severity < 2) {
        impact = 'medium';
        severity = 2;
      }
    } else if (responseTime > 1000) {
      if (severity < 1) {
        impact = 'low';
        severity = 1;
      }
    }

    return {
      level: impact,
      severity: severity,
      description: this.getImpactDescription(impact, statusCode, responseTime)
    };
  }

  getImpactDescription(impact, statusCode, responseTime) {
    if (impact === 'critical') {
      return 'Critical SEO issues detected. Immediate action required to prevent search engine deindexing.';
    } else if (impact === 'high') {
      return 'High SEO impact. Address these issues to maintain search engine visibility.';
    } else if (impact === 'medium') {
      return 'Moderate SEO impact. Consider optimizing for better search performance.';
    } else if (impact === 'low') {
      return 'Minor SEO impact. Small optimizations can improve user experience.';
    } else {
      return 'No significant SEO issues detected from status codes and performance.';
    }
  }
}

module.exports = SEOReporter;