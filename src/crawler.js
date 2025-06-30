const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');
const { URL } = require('url');

class SEOCrawler {
  constructor() {
    this.userAgent = 'SEO-Crawler/1.0';
  }

  async analyzePage(url, timeoutMs = 10000) {
    const startTime = Date.now();
    let response = null;
    let error = null;

    try {
      // Initialize redirect tracking
      const redirectChain = [];
      let currentUrl = url;
      
      // First attempt with SSL validation
      try {
        response = await axios.get(url, {
          headers: {
            'User-Agent': this.userAgent,
            'Connection': 'keep-alive'
          },
          timeout: timeoutMs,
          maxRedirects: 5,
          validateStatus: () => true,
          // Enable redirect interception to track redirect chain
          beforeRedirect: (options, { headers, statusCode }) => {
            // Store redirect information
            redirectChain.push({
              fromUrl: currentUrl,
              toUrl: headers.location,
              statusCode: statusCode,
              headers: headers,
              timestamp: Date.now()
            });
            // Update current URL for next redirect
            currentUrl = headers.location;
          }
        });
        
        // Attach redirect chain to response for later use
        response.redirectChain = redirectChain;
      } catch (sslError) {
        // If it's an SSL error, try again without SSL validation
        if (sslError.code && (
          sslError.code.includes('CERT_') || 
          sslError.code.includes('UNABLE_TO_') ||
          sslError.code.includes('SELF_SIGNED') ||
          sslError.code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
        )) {
          console.log(`SSL error for ${url}, retrying without SSL validation: ${sslError.code}`);
          
          // Create HTTPS agent that ignores SSL errors
          const httpsAgent = new https.Agent({
            rejectUnauthorized: false,
            secureProtocol: 'TLSv1_2_method'
          });
          
          response = await axios.get(url, {
            headers: {
              'User-Agent': this.userAgent,
              'Connection': 'keep-alive'
            },
            timeout: timeoutMs,
            maxRedirects: 5,
            validateStatus: () => true,
            httpsAgent: httpsAgent,
            // Enable redirect interception to track redirect chain
            beforeRedirect: (options, { headers, statusCode }) => {
              // Store redirect information
              redirectChain.push({
                fromUrl: currentUrl,
                toUrl: headers.location,
                statusCode: statusCode,
                headers: headers,
                timestamp: Date.now()
              });
              // Update current URL for next redirect
              currentUrl = headers.location;
            }
          });
          
          // Attach redirect chain to response for later use
          response.redirectChain = redirectChain;
          
          // Mark that SSL validation failed but we proceeded anyway
          response.sslValidationFailed = true;
          response.sslError = sslError.code;
        } else {
          throw sslError; // Re-throw non-SSL errors
        }
      }

      const responseTime = Date.now() - startTime;
      const $ = cheerio.load(response.data);
      const baseUrl = new URL(url);

      // Analyze status code information
      const statusInfo = this.analyzeStatusCode(response, responseTime);

      return {
        url: url,
        finalUrl: response.request.res.responseUrl || url,
        statusCode: response.status,
        statusInfo: statusInfo,
        meta: this.extractMetaData($),
        headings: this.extractHeadings($),
        images: this.extractImages($, baseUrl),
        links: this.extractLinks($, baseUrl),
        content: this.analyzeContent($),
        technical: this.analyzeTechnical($, response),
        schema: this.extractStructuredData($),
        pwa: await this.analyzePWA($, baseUrl)
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorInfo = this.analyzeNetworkError(error, responseTime);
      
      throw new Error(`Failed to analyze ${url}: ${errorInfo.message}`, {
        cause: {
          url: url,
          responseTime: responseTime,
          errorType: errorInfo.type,
          errorDetails: errorInfo.details,
          isNetworkError: true
        }
      });
    }
  }

  analyzeStatusCode(response, responseTime) {
    const statusCode = response.status;
    const statusCategory = this.getStatusCategory(statusCode);
    const statusMessage = this.getStatusMessage(statusCode);
    const redirectChain = this.getRedirectChain(response);
    const isHealthy = this.isStatusHealthy(statusCode);

    // Check for SSL validation issues
    const sslIssues = response.sslValidationFailed ? {
      sslValidationFailed: true,
      sslError: response.sslError,
      sslWarning: 'SSL certificate validation failed - accessed with bypassed validation'
    } : {
      sslValidationFailed: false
    };

    return {
      statusCode: statusCode,
      statusCategory: statusCategory,
      statusMessage: statusMessage,
      responseTime: responseTime,
      redirectChain: redirectChain,
      isHealthy: isHealthy && !response.sslValidationFailed, // SSL issues affect health
      details: {
        isRedirect: statusCategory === 'redirect',
        isClientError: statusCategory === 'client_error',
        isServerError: statusCategory === 'server_error',
        redirectCount: redirectChain.length,
        finalUrl: redirectChain.length > 0 ? redirectChain[redirectChain.length - 1].toUrl : 
                  (response.request.res.responseUrl || response.config.url),
        redirectSummary: redirectChain.length > 0 ? {
          totalRedirects: redirectChain.length,
          redirectTypes: redirectChain.map(r => r.redirectType),
          hasTemporaryRedirects: redirectChain.some(r => r.redirectType === 'temporary' || r.redirectType === 'temporary_preserve_method'),
          hasPermanentRedirects: redirectChain.some(r => r.redirectType === 'permanent' || r.redirectType === 'permanent_preserve_method'),
          redirectPath: redirectChain.map(r => `${r.fromUrl} → ${r.toUrl} (${r.statusCode})`).join(' → ')
        } : null,
        ssl: sslIssues,
        headers: {
          server: response.headers.server || 'Unknown',
          contentType: response.headers['content-type'] || 'Unknown',
          cacheControl: response.headers['cache-control'] || 'Not set',
          lastModified: response.headers['last-modified'] || 'Not set',
          etag: response.headers.etag || 'Not set'
        }
      }
    };
  }

  getStatusCategory(statusCode) {
    if (statusCode >= 200 && statusCode < 300) return 'success';
    if (statusCode >= 300 && statusCode < 400) return 'redirect';
    if (statusCode >= 400 && statusCode < 500) return 'client_error';
    if (statusCode >= 500 && statusCode < 600) return 'server_error';
    return 'unknown';
  }

  getStatusMessage(statusCode) {
    const statusMessages = {
      200: 'OK - Request successful',
      201: 'Created - Resource successfully created',
      202: 'Accepted - Request accepted for processing',
      204: 'No Content - Request successful, no content returned',
      301: 'Moved Permanently - Resource permanently moved to new location',
      302: 'Found - Resource temporarily moved to new location',
      303: 'See Other - Resource available at different URI',
      304: 'Not Modified - Resource unchanged since last request',
      307: 'Temporary Redirect - Resource temporarily moved, method preserved',
      308: 'Permanent Redirect - Resource permanently moved, method preserved',
      400: 'Bad Request - Invalid request syntax',
      401: 'Unauthorized - Authentication required',
      403: 'Forbidden - Server understood request but refuses to authorize',
      404: 'Not Found - Requested resource not found',
      405: 'Method Not Allowed - Request method not supported',
      406: 'Not Acceptable - Content not acceptable according to Accept headers',
      410: 'Gone - Resource no longer available and will not be available again',
      429: 'Too Many Requests - Rate limit exceeded',
      500: 'Internal Server Error - Server encountered unexpected condition',
      501: 'Not Implemented - Server does not support functionality required',
      502: 'Bad Gateway - Server received invalid response from upstream server',
      503: 'Service Unavailable - Server temporarily overloaded or under maintenance',
      504: 'Gateway Timeout - Server did not receive timely response from upstream server'
    };

    return statusMessages[statusCode] || `${statusCode} - ${this.getGenericStatusMessage(statusCode)}`;
  }

  getGenericStatusMessage(statusCode) {
    if (statusCode >= 200 && statusCode < 300) return 'Success';
    if (statusCode >= 300 && statusCode < 400) return 'Redirection';
    if (statusCode >= 400 && statusCode < 500) return 'Client Error';
    if (statusCode >= 500 && statusCode < 600) return 'Server Error';
    return 'Unknown Status';
  }

  getRedirectType(statusCode) {
    switch (statusCode) {
      case 301:
        return 'permanent';
      case 302:
        return 'temporary';
      case 303:
        return 'see_other';
      case 307:
        return 'temporary_preserve_method';
      case 308:
        return 'permanent_preserve_method';
      default:
        return 'unknown';
    }
  }

  getRedirectChain(response) {
    const redirectChain = [];
    
    // Check for redirect chain stored during beforeRedirect callback
    if (response.redirectChain && response.redirectChain.length > 0) {
      response.redirectChain.forEach((redirect, index) => {
        redirectChain.push({
          step: index + 1,
          fromUrl: redirect.fromUrl || response.config.url,
          toUrl: redirect.toUrl || (response.request.res.responseUrl || response.config.url),
          statusCode: redirect.statusCode,
          statusText: this.getStatusMessage(redirect.statusCode),
          method: 'GET',
          headers: {
            location: redirect.headers.location || '',
            server: redirect.headers.server || '',
            'cache-control': redirect.headers['cache-control'] || ''
          },
          timestamp: redirect.timestamp,
          redirectType: this.getRedirectType(redirect.statusCode)
        });
      });
      return redirectChain; // Early return if we have custom redirect chain
    }
    
    // Fallback: Check for redirect chain stored in config (legacy)
    if (response.config && response.config.redirectChain) {
      response.config.redirectChain.forEach((redirect, index) => {
        redirectChain.push({
          step: index + 1,
          fromUrl: redirect.fromUrl,
          toUrl: redirect.toUrl || (index < response.config.redirectChain.length - 1 ? 
                 response.config.redirectChain[index + 1].fromUrl : 
                 (response.request.res.responseUrl || response.config.url)),
          statusCode: redirect.statusCode,
          statusText: this.getStatusMessage(redirect.statusCode),
          method: 'GET',
          headers: {
            location: redirect.headers.location || '',
            server: redirect.headers.server || '',
            'cache-control': redirect.headers['cache-control'] || ''
          },
          timestamp: redirect.timestamp,
          redirectType: this.getRedirectType(redirect.statusCode)
        });
      });
    }

    // Fallback: Check if response object has redirect history (older axios versions)
    if (redirectChain.length === 0 && response.request && response.request._redirects) {
      response.request._redirects.forEach((redirect, index) => {
        redirectChain.push({
          step: index + 1,
          fromUrl: redirect.redirectURL || redirect.url,
          toUrl: index < response.request._redirects.length - 1 ? 
                 response.request._redirects[index + 1].redirectURL : 
                 (response.request.res.responseUrl || response.config.url),
          statusCode: redirect.statusCode || redirect.status,
          statusText: this.getStatusMessage(redirect.statusCode || redirect.status),
          method: redirect.method || 'GET',
          headers: redirect.headers || {},
          redirectType: this.getRedirectType(redirect.statusCode || redirect.status)
        });
      });
    }

    // Final fallback: If using axios and there's a URL difference
    if (redirectChain.length === 0 && response.request && response.request.res && response.request.res.responseUrl) {
      const finalUrl = response.request.res.responseUrl;
      const originalUrl = response.config ? response.config.url : null;
      
      if (originalUrl && finalUrl && originalUrl !== finalUrl) {
        redirectChain.push({
          step: 1,
          fromUrl: originalUrl,
          toUrl: finalUrl,
          statusCode: response.status,
          statusText: this.getStatusMessage(response.status),
          method: response.config.method.toUpperCase(),
          headers: response.headers || {},
          redirectType: 'unknown'
        });
      }
    }

    return redirectChain;
  }

  isStatusHealthy(statusCode) {
    // 2xx status codes are generally healthy
    if (statusCode >= 200 && statusCode < 300) return true;
    
    // 304 Not Modified is healthy for caching
    if (statusCode === 304) return true;
    
    // Other status codes are considered unhealthy for SEO
    return false;
  }

  analyzeNetworkError(error, responseTime) {
    let errorType = 'unknown';
    let message = error.message;
    let details = {};

    if (error.code) {
      switch (error.code) {
        case 'ENOTFOUND':
          errorType = 'dns_error';
          message = 'DNS resolution failed - domain not found';
          details = {
            description: 'The domain name could not be resolved to an IP address',
            possibleCauses: ['Domain does not exist', 'DNS server issues', 'Network connectivity problems'],
            seoImpact: 'Critical - Search engines cannot access the site'
          };
          break;
          
        case 'ECONNREFUSED':
          errorType = 'connection_refused';
          message = 'Connection refused by server';
          details = {
            description: 'The server actively refused the connection',
            possibleCauses: ['Server is down', 'Port is blocked', 'Firewall blocking connection'],
            seoImpact: 'Critical - Site is completely inaccessible'
          };
          break;
          
        case 'ETIMEDOUT':
        case 'ECONNRESET':
          errorType = 'timeout';
          message = 'Request timed out';
          details = {
            description: 'The server did not respond within the timeout period',
            possibleCauses: ['Server overload', 'Slow network connection', 'Server processing issues'],
            seoImpact: 'High - Poor site performance affects rankings'
          };
          break;
          
        case 'CERT_UNTRUSTED':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          errorType = 'ssl_error';
          message = 'SSL certificate error';
          details = {
            description: 'There is an issue with the site\'s SSL certificate',
            possibleCauses: ['Expired certificate', 'Self-signed certificate', 'Certificate chain issues'],
            seoImpact: 'High - SSL issues affect trust signals and rankings'
          };
          break;
          
        case 'HPE_INVALID_HEADER_TOKEN':
        case 'ERR_INVALID_URL':
          errorType = 'protocol_error';
          message = 'HTTP protocol error';
          details = {
            description: 'Invalid HTTP response or malformed URL',
            possibleCauses: ['Server configuration issues', 'Malformed response headers', 'Invalid URL format'],
            seoImpact: 'Medium - May affect crawling efficiency'
          };
          break;
          
        default:
          errorType = 'network_error';
          message = `Network error: ${error.code}`;
          details = {
            description: 'A network-level error occurred',
            possibleCauses: ['Network connectivity issues', 'Server configuration problems'],
            seoImpact: 'Variable - Depends on error frequency and duration'
          };
      }
    } else if (error.response) {
      // This shouldn't happen with validateStatus: () => true, but just in case
      errorType = 'http_error';
      message = `HTTP ${error.response.status}: ${error.response.statusText}`;
      details = {
        statusCode: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers
      };
    }

    return {
      type: errorType,
      message: message,
      details: details,
      responseTime: responseTime,
      timestamp: new Date().toISOString()
    };
  }

  extractMetaData($) {
    const title = $('title').text().trim();
    const description = $('meta[name="description"]').attr('content') || '';
    const keywords = $('meta[name="keywords"]').attr('content') || '';
    
    return {
      title: title,
      titleLength: title.length,
      description: description,
      descriptionLength: description.length,
      keywords: keywords,
      keywordsCount: keywords ? keywords.split(',').length : 0,
      
      // Open Graph
      ogTitle: $('meta[property="og:title"]').attr('content') || '',
      ogDescription: $('meta[property="og:description"]').attr('content') || '',
      ogImage: $('meta[property="og:image"]').attr('content') || '',
      ogType: $('meta[property="og:type"]').attr('content') || '',
      ogUrl: $('meta[property="og:url"]').attr('content') || '',
      ogSiteName: $('meta[property="og:site_name"]').attr('content') || '',
      
      // Twitter Cards
      twitterCard: $('meta[name="twitter:card"]').attr('content') || '',
      twitterTitle: $('meta[name="twitter:title"]').attr('content') || '',
      twitterDescription: $('meta[name="twitter:description"]').attr('content') || '',
      twitterImage: $('meta[name="twitter:image"]').attr('content') || '',
      twitterSite: $('meta[name="twitter:site"]').attr('content') || '',
      
      // Technical SEO
      canonical: $('link[rel="canonical"]').attr('href') || '',
      robots: $('meta[name="robots"]').attr('content') || '',
      viewport: $('meta[name="viewport"]').attr('content') || '',
      charset: $('meta[charset]').attr('charset') || $('meta[http-equiv="Content-Type"]').attr('content') || '',
      
      // Language and locale
      lang: $('html').attr('lang') || '',
      hreflang: [],
      
      // Additional meta tags
      author: $('meta[name="author"]').attr('content') || '',
      generator: $('meta[name="generator"]').attr('content') || '',
      theme: $('meta[name="theme-color"]').attr('content') || ''
    };
  }

  extractHeadings($) {
    const headings = {};
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
      headings[tag] = [];
      $(tag).each((i, el) => {
        headings[tag].push($(el).text().trim());
      });
    });
    return headings;
  }

  extractImages($, baseUrl) {
    const images = [];
    $('img').each((i, el) => {
      const $img = $(el);
      const src = $img.attr('src');
      if (src) {
        const alt = $img.attr('alt') || '';
        const title = $img.attr('title') || '';
        const width = $img.attr('width') || '';
        const height = $img.attr('height') || '';
        const loading = $img.attr('loading') || '';
        const className = $img.attr('class') || '';
        
        // Get surrounding context for better identification
        const parent = $img.parent();
        const parentTag = parent.prop('tagName') || '';
        const parentClass = parent.attr('class') || '';
        const parentId = parent.attr('id') || '';
        
        // Get any nearby text for context
        const nearbyText = $img.parent().text().trim().substring(0, 100);
        
        images.push({
          src: this.resolveUrl(src, baseUrl),
          originalSrc: src,
          alt: alt,
          title: title,
          width: width,
          height: height,
          loading: loading,
          className: className,
          hasAlt: !!alt,
          isEmpty: !alt || alt.trim() === '',
          isDecorative: alt === '', // Empty alt suggests decorative
          altLength: alt.length,
          context: {
            parentTag: parentTag,
            parentClass: parentClass,
            parentId: parentId,
            nearbyText: nearbyText,
            htmlSnippet: $.html($img).substring(0, 200)
          }
        });
      }
    });
    return images;
  }

  extractLinks($, baseUrl) {
    const links = {
      internal: [],
      external: []
    };

    $('a[href]').each((i, el) => {
      const $link = $(el);
      const href = $link.attr('href');
      const text = $link.text().trim();
      const title = $link.attr('title') || '';

      if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
        const resolvedUrl = this.resolveUrl(href, baseUrl);
        const linkData = {
          href: resolvedUrl,
          text: text,
          title: title,
          rel: $link.attr('rel') || ''
        };

        if (this.isInternalLink(resolvedUrl, baseUrl)) {
          links.internal.push(linkData);
        } else {
          links.external.push(linkData);
        }
      }
    });

    return links;
  }

  analyzeContent($) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const words = bodyText.split(' ').filter(word => word.length > 0);
    
    return {
      wordCount: words.length,
      characterCount: bodyText.length,
      readabilityScore: this.calculateReadability(words, $('p').length)
    };
  }

  analyzeTechnical($, response) {
    return {
      hasH1: $('h1').length > 0,
      h1Count: $('h1').length,
      hasMetaDescription: !!$('meta[name="description"]').attr('content'),
      hasCanonical: !!$('link[rel="canonical"]').attr('href'),
      contentType: response.headers['content-type'] || 'N/A',
      contentLength: response.headers['content-length'] || 'N/A',
      server: response.headers.server || 'Unknown',
      cacheControl: response.headers['cache-control'] || 'Not set',
      lastModified: response.headers['last-modified'] || 'Not set',
      etag: response.headers.etag || 'Not set',
      xFrameOptions: response.headers['x-frame-options'] || 'Not set',
      contentSecurityPolicy: response.headers['content-security-policy'] || 'Not set',
      strictTransportSecurity: response.headers['strict-transport-security'] || 'Not set'
    };
  }

  resolveUrl(url, baseUrl) {
    try {
      return new URL(url, baseUrl.origin).href;
    } catch {
      return url;
    }
  }

  isInternalLink(url, baseUrl) {
    try {
      const linkUrl = new URL(url);
      return linkUrl.hostname === baseUrl.hostname;
    } catch {
      return false;
    }
  }

  calculateReadability(words, paragraphCount) {
    if (words.length === 0 || paragraphCount === 0) return 0;
    const avgWordsPerSentence = words.length / paragraphCount;
    return Math.round(206.835 - (1.015 * avgWordsPerSentence));
  }

  extractStructuredData($) {
    const structuredData = {
      jsonLd: [],
      microdata: [],
      rdfa: [],
      errors: [],
      summary: {
        totalSchemas: 0,
        hasOrganization: false,
        hasWebsite: false,
        hasWebApplication: false,
        hasProduct: false,
        hasArticle: false,
        hasBreadcrumb: false,
        hasLocalBusiness: false,
        hasReview: false,
        hasFAQ: false,
        hasPerson: false,
        hasEvent: false,
        hasRecipe: false,
        hasVideoObject: false,
        hasImageObject: false,
        hasService: false,
        hasJobPosting: false,
        hasCourse: false,
        hasBook: false,
        hasMovie: false,
        hasRestaurant: false,
        // Specific element checks
        hasAuthor: false,
        hasPublisher: false,
        hasFocusKeyword: false,
        hasSection: false
      },
      detailedAnalysis: {
        Organization: [],
        WebSite: [],
        Product: [],
        Article: [],
        BreadcrumbList: [],
        LocalBusiness: [],
        Review: [],
        FAQPage: [],
        Person: [],
        Event: [],
        Recipe: [],
        VideoObject: [],
        ImageObject: [],
        Service: [],
        JobPosting: [],
        Course: [],
        Book: [],
        Movie: [],
        Restaurant: []
      }
    };

    // Extract JSON-LD
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const content = $(el).html().trim();
        if (content) {
          const jsonData = JSON.parse(content);
          const schemas = Array.isArray(jsonData) ? jsonData : [jsonData];
          
          schemas.forEach(schema => {
            if (schema['@type']) {
              const detailedValidation = this.getDetailedSchemaValidation(schema);
              
              structuredData.jsonLd.push({
                type: schema['@type'],
                context: schema['@context'] || '',
                data: schema,
                element: $(el).toString(),
                valid: this.validateSchema(schema),
                errors: this.getSchemaErrors(schema),
                detailedValidation: detailedValidation
              });
              
              // Update summary and detailed analysis
              this.updateSchemaSummary(structuredData.summary, schema['@type']);
              this.addToDetailedAnalysis(structuredData.detailedAnalysis, schema);
            }
          });
        }
      } catch (error) {
        structuredData.errors.push({
          type: 'JSON-LD Parse Error',
          message: error.message,
          element: $(el).toString().substring(0, 200)
        });
      }
    });

    // Extract Microdata
    $('[itemscope]').each((i, el) => {
      const $el = $(el);
      const itemType = $el.attr('itemtype');
      const itemProp = $el.attr('itemprop');
      
      if (itemType) {
        const microdataItem = {
          type: itemType,
          element: $el.toString().substring(0, 200),
          properties: this.extractMicrodataProperties($, $el),
          valid: true // Basic validation for now
        };
        
        structuredData.microdata.push(microdataItem);
        
        // Update summary
        const schemaType = itemType.split('/').pop();
        this.updateSchemaSummary(structuredData.summary, schemaType);
      }
    });

    // Extract RDFa (basic detection)
    $('[typeof]').each((i, el) => {
      const $el = $(el);
      const typeOf = $el.attr('typeof');
      
      if (typeOf) {
        structuredData.rdfa.push({
          type: typeOf,
          element: $el.toString().substring(0, 200),
          properties: this.extractRdfaProperties($, $el)
        });
        
        // Update summary
        this.updateSchemaSummary(structuredData.summary, typeOf);
      }
    });

    // Calculate totals
    structuredData.summary.totalSchemas = 
      structuredData.jsonLd.length + 
      structuredData.microdata.length + 
      structuredData.rdfa.length;

    // Check for specific schema elements across all schemas
    this.checkSpecificSchemaElements(structuredData, $);

    return structuredData;
  }

  checkSpecificSchemaElements(structuredData, $) {
    // Check for Author in various schema types and meta tags
    let hasAuthor = false;
    
    // Check in JSON-LD schemas
    structuredData.jsonLd.forEach(schema => {
      const data = schema.data;
      if (data.author || data.creator || data.contributor) {
        hasAuthor = true;
      }
      // Check in Article schema specifically
      if (data['@type'] === 'Article' && data.author) {
        hasAuthor = true;
      }
      // Check in Organization schema for founder/founder
      if (data['@type'] === 'Organization' && (data.founder || data.employee)) {
        hasAuthor = true;
      }
    });
    
    // Check meta tags for author
    if (!hasAuthor) {
      const authorMeta = $('meta[name="author"]').attr('content');
      if (authorMeta && authorMeta.trim() !== '') {
        hasAuthor = true;
      }
    }
    
    structuredData.summary.hasAuthor = hasAuthor;

    // Check for Publisher in schemas
    let hasPublisher = false;
    structuredData.jsonLd.forEach(schema => {
      const data = schema.data;
      if (data.publisher) {
        hasPublisher = true;
      }
      // Check in Article schema specifically
      if (data['@type'] === 'Article' && data.publisher) {
        hasPublisher = true;
      }
    });
    structuredData.summary.hasPublisher = hasPublisher;

    // Check for Focus Keyword (in meta keywords, title, h1, description)
    let hasFocusKeyword = false;
    const keywords = $('meta[name="keywords"]').attr('content');
    const title = $('title').text();
    const description = $('meta[name="description"]').attr('content');
    const h1 = $('h1').first().text();
    
    // Simple check - if keywords meta tag exists with content
    if (keywords && keywords.trim() !== '') {
      hasFocusKeyword = true;
    }
    
    // Check for focus keyword in schema
    structuredData.jsonLd.forEach(schema => {
      const data = schema.data;
      if (data.keywords || data.about || data.mainEntity) {
        hasFocusKeyword = true;
      }
    });
    
    structuredData.summary.hasFocusKeyword = hasFocusKeyword;

    // Check for Section/Article Section
    let hasSection = false;
    
    // Check HTML5 section tags
    if ($('section').length > 0) {
      hasSection = true;
    }
    
    // Check in schema for articleSection
    structuredData.jsonLd.forEach(schema => {
      const data = schema.data;
      if (data.articleSection || data.section || data.category) {
        hasSection = true;
      }
    });
    
    // Check microdata for section
    structuredData.microdata.forEach(item => {
      if (item.properties && (item.properties.articleSection || item.properties.section)) {
        hasSection = true;
      }
    });
    
    structuredData.summary.hasSection = hasSection;

    // Enhanced Breadcrumb List checking
    let hasBreadcrumb = structuredData.summary.hasBreadcrumb;
    
    // Additional checks for breadcrumb patterns
    if (!hasBreadcrumb) {
      // Check for common breadcrumb class names and structures
      const breadcrumbSelectors = [
        '.breadcrumb',
        '.breadcrumbs', 
        '[role="navigation"] ol',
        '[role="navigation"] ul',
        '.nav-breadcrumb',
        '.page-breadcrumb',
        '.breadcrumb-navigation'
      ];
      
      breadcrumbSelectors.forEach(selector => {
        if ($(selector).length > 0) {
          hasBreadcrumb = true;
        }
      });
      
      // Check for JSON-LD BreadcrumbList more thoroughly
      structuredData.jsonLd.forEach(schema => {
        const data = schema.data;
        if (data['@type'] === 'BreadcrumbList' || 
            (data.itemListElement && Array.isArray(data.itemListElement))) {
          hasBreadcrumb = true;
        }
      });
    }
    
    structuredData.summary.hasBreadcrumb = hasBreadcrumb;
  }

  validateSchema(schema) {
    if (!schema['@type']) return false;
    if (!schema['@context']) return false;
    
    // Basic validation rules for common schema types
    const type = schema['@type'];
    
    switch (type) {
      case 'Organization':
        return !!(schema.name && schema.url);
      case 'Product':
        return !!(schema.name && schema.description);
      case 'Article':
        return !!(schema.headline && schema.author);
      case 'WebSite':
        return !!(schema.name && schema.url);
      case 'LocalBusiness':
        return !!(schema.name && schema.address);
      default:
        return true; // Basic validation passed
    }
  }

  getSchemaErrors(schema) {
    const errors = [];
    const type = schema['@type'];

    // Check required properties for common schema types
    switch (type) {
      case 'Organization':
        if (!schema.name) errors.push('Missing required property: name');
        if (!schema.url) errors.push('Missing required property: url');
        if (!schema.logo) errors.push('Recommended property missing: logo');
        break;
        
      case 'Product':
        if (!schema.name) errors.push('Missing required property: name');
        if (!schema.description) errors.push('Missing required property: description');
        if (!schema.offers) errors.push('Missing recommended property: offers');
        if (!schema.image) errors.push('Missing recommended property: image');
        break;
        
      case 'Article':
        if (!schema.headline) errors.push('Missing required property: headline');
        if (!schema.author) errors.push('Missing required property: author');
        if (!schema.datePublished) errors.push('Missing recommended property: datePublished');
        if (!schema.image) errors.push('Missing recommended property: image');
        break;
        
      case 'WebSite':
        if (!schema.name) errors.push('Missing required property: name');
        if (!schema.url) errors.push('Missing required property: url');
        break;
        
      case 'LocalBusiness':
        if (!schema.name) errors.push('Missing required property: name');
        if (!schema.address) errors.push('Missing required property: address');
        if (!schema.telephone) errors.push('Missing recommended property: telephone');
        if (!schema.openingHours) errors.push('Missing recommended property: openingHours');
        break;
    }

    return errors;
  }

  extractMicrodataProperties($, $element) {
    const properties = {};
    
    $element.find('[itemprop]').each((i, el) => {
      const $el = $(el);
      const prop = $el.attr('itemprop');
      const value = $el.attr('content') || $el.text().trim();
      
      if (prop && value) {
        properties[prop] = value;
      }
    });
    
    return properties;
  }

  extractRdfaProperties($, $element) {
    const properties = {};
    
    $element.find('[property]').each((i, el) => {
      const $el = $(el);
      const prop = $el.attr('property');
      const value = $el.attr('content') || $el.text().trim();
      
      if (prop && value) {
        properties[prop] = value;
      }
    });
    
    return properties;
  }

  updateSchemaSummary(summary, schemaType) {
    const type = schemaType.toLowerCase();
    
    if (type.includes('organization')) summary.hasOrganization = true;
    if (type.includes('website')) summary.hasWebsite = true;
    if (type.includes('webapplication')) summary.hasWebApplication = true;
    if (type.includes('product')) summary.hasProduct = true;
    if (type.includes('article')) summary.hasArticle = true;
    if (type.includes('breadcrumb')) summary.hasBreadcrumb = true;
    if (type.includes('localbusiness')) summary.hasLocalBusiness = true;
    if (type.includes('review')) summary.hasReview = true;
    if (type.includes('faq')) summary.hasFAQ = true;
    if (type.includes('person')) summary.hasPerson = true;
    if (type.includes('event')) summary.hasEvent = true;
    if (type.includes('recipe')) summary.hasRecipe = true;
    if (type.includes('videoobject')) summary.hasVideoObject = true;
    if (type.includes('imageobject')) summary.hasImageObject = true;
    if (type.includes('service')) summary.hasService = true;
    if (type.includes('jobposting')) summary.hasJobPosting = true;
    if (type.includes('course')) summary.hasCourse = true;
    if (type.includes('book')) summary.hasBook = true;
    if (type.includes('movie')) summary.hasMovie = true;
    if (type.includes('restaurant')) summary.hasRestaurant = true;
  }

  addToDetailedAnalysis(detailedAnalysis, schema) {
    const type = schema['@type'];
    if (detailedAnalysis[type]) {
      detailedAnalysis[type].push({
        data: schema,
        validation: this.getDetailedSchemaValidation(schema)
      });
    }
  }

  getDetailedSchemaValidation(schema) {
    const type = schema['@type'];
    const validation = {
      type: type,
      properties: {},
      score: 0,
      maxScore: 0,
      completeness: 0,
      checklist: []
    };

    switch (type) {
      case 'Organization':
        return this.validateOrganizationSchema(schema);
      case 'WebSite':
        return this.validateWebSiteSchema(schema);
      case 'WebApplication':
        return this.validateWebApplicationSchema(schema);
      case 'Product':
        return this.validateProductSchema(schema);
      case 'Article':
        return this.validateArticleSchema(schema);
      case 'BreadcrumbList':
        return this.validateBreadcrumbSchema(schema);
      case 'LocalBusiness':
        return this.validateLocalBusinessSchema(schema);
      case 'Review':
        return this.validateReviewSchema(schema);
      case 'FAQPage':
        return this.validateFAQSchema(schema);
      case 'Person':
        return this.validatePersonSchema(schema);
      case 'Event':
        return this.validateEventSchema(schema);
      case 'Recipe':
        return this.validateRecipeSchema(schema);
      case 'VideoObject':
        return this.validateVideoObjectSchema(schema);
      case 'JobPosting':
        return this.validateJobPostingSchema(schema);
      default:
        return this.validateGenericSchema(schema);
    }
  }

  validateOrganizationSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Critical for identification', example: '"name": "Your Company Name"' },
      { property: 'url', required: true, present: !!schema.url, impact: 'Required for website association', example: '"url": "https://www.yoursite.com"' },
      { property: 'logo', required: false, present: !!schema.logo, impact: 'Improves brand recognition in search', example: '"logo": "https://www.yoursite.com/logo.png"' },
      { property: 'description', required: false, present: !!schema.description, impact: 'Helps search engines understand your business', example: '"description": "We provide excellent services..."' },
      { property: 'address', required: false, present: !!schema.address, impact: 'Important for local SEO', example: '"address": {"@type": "PostalAddress", "streetAddress": "123 Main St"}' },
      { property: 'telephone', required: false, present: !!schema.telephone, impact: 'Enables click-to-call features', example: '"telephone": "+1-555-555-5555"' },
      { property: 'email', required: false, present: !!schema.email, impact: 'Provides contact information', example: '"email": "contact@yoursite.com"' },
      { property: 'sameAs', required: false, present: !!schema.sameAs, impact: 'Links social media profiles', example: '"sameAs": ["https://facebook.com/yourpage"]' },
      { property: 'foundingDate', required: false, present: !!schema.foundingDate, impact: 'Shows business history', example: '"foundingDate": "2020-01-01"' },
      { property: 'contactPoint', required: false, present: !!schema.contactPoint, impact: 'Structured contact information', example: '"contactPoint": {"@type": "ContactPoint", "telephone": "+1-555-555-5555", "contactType": "customer service"}' }
    ];

    return this.calculateValidationScore(checklist, 'Organization');
  }

  validateArticleSchema(schema) {
    const checklist = [
      { property: 'headline', required: true, present: !!schema.headline, impact: 'Article title for search results', example: '"headline": "Your Article Title"' },
      { property: 'author', required: true, present: !!schema.author, impact: 'Establishes content authorship', example: '"author": {"@type": "Person", "name": "John Doe"}' },
      { property: 'datePublished', required: true, present: !!schema.datePublished, impact: 'Critical for news and blog articles', example: '"datePublished": "2024-01-01T00:00:00Z"' },
      { property: 'dateModified', required: false, present: !!schema.dateModified, impact: 'Shows content freshness', example: '"dateModified": "2024-01-15T00:00:00Z"' },
      { property: 'image', required: true, present: !!schema.image, impact: 'Required for rich snippets', example: '"image": "https://www.yoursite.com/article-image.jpg"' },
      { property: 'publisher', required: true, present: !!schema.publisher, impact: 'Identifies content publisher', example: '"publisher": {"@type": "Organization", "name": "Your Site", "logo": {"@type": "ImageObject", "url": "https://www.yoursite.com/logo.png"}}' },
      { property: 'description', required: false, present: !!schema.description, impact: 'Article summary for search results', example: '"description": "Brief description of your article content"' },
      { property: 'mainEntityOfPage', required: false, present: !!schema.mainEntityOfPage, impact: 'Identifies main content URL', example: '"mainEntityOfPage": "https://www.yoursite.com/article-url"' },
      { property: 'wordCount', required: false, present: !!schema.wordCount, impact: 'Indicates content depth', example: '"wordCount": 1500' },
      { property: 'articleSection', required: false, present: !!schema.articleSection, impact: 'Categorizes content', example: '"articleSection": "Technology"' }
    ];

    return this.calculateValidationScore(checklist, 'Article');
  }

  validateProductSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Product name in search results', example: '"name": "Your Product Name"' },
      { property: 'description', required: true, present: !!schema.description, impact: 'Product details for rich snippets', example: '"description": "Detailed product description"' },
      { property: 'image', required: true, present: !!schema.image, impact: 'Product image in search results', example: '"image": "https://www.yoursite.com/product-image.jpg"' },
      { property: 'offers', required: true, present: !!schema.offers, impact: 'Essential for price display', example: '"offers": {"@type": "Offer", "price": "29.99", "priceCurrency": "USD", "availability": "https://schema.org/InStock"}' },
      { property: 'brand', required: false, present: !!schema.brand, impact: 'Brand recognition in search', example: '"brand": {"@type": "Brand", "name": "Your Brand"}' },
      { property: 'sku', required: false, present: !!schema.sku, impact: 'Product identification', example: '"sku": "SKU123456"' },
      { property: 'gtin', required: false, present: !!schema.gtin, impact: 'Global product identifier', example: '"gtin": "1234567890123"' },
      { property: 'review', required: false, present: !!schema.review, impact: 'Shows customer feedback', example: '"review": {"@type": "Review", "reviewRating": {"@type": "Rating", "ratingValue": "5"}, "author": {"@type": "Person", "name": "John Doe"}}' },
      { property: 'aggregateRating', required: false, present: !!schema.aggregateRating, impact: 'Star ratings in search results', example: '"aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.5", "reviewCount": "100"}' },
      { property: 'category', required: false, present: !!schema.category, impact: 'Product categorization', example: '"category": "Electronics"' }
    ];

    return this.calculateValidationScore(checklist, 'Product');
  }

  validateFAQSchema(schema) {
    const checklist = [
      { property: 'mainEntity', required: true, present: !!schema.mainEntity, impact: 'Contains the FAQ questions and answers', example: '"mainEntity": [{"@type": "Question", "name": "What is...?", "acceptedAnswer": {"@type": "Answer", "text": "The answer is..."}}]' },
      { property: '@type', required: true, present: schema['@type'] === 'FAQPage', impact: 'Identifies this as an FAQ page', example: '"@type": "FAQPage"' }
    ];

    // Additional validation for FAQ structure
    if (schema.mainEntity) {
      const questions = Array.isArray(schema.mainEntity) ? schema.mainEntity : [schema.mainEntity];
      questions.forEach((question, index) => {
        checklist.push({
          property: `Question ${index + 1} name`,
          required: true,
          present: !!question.name,
          impact: 'Question text for rich snippets',
          example: '"name": "What is your return policy?"'
        });
        checklist.push({
          property: `Question ${index + 1} answer`,
          required: true,
          present: !!(question.acceptedAnswer && question.acceptedAnswer.text),
          impact: 'Answer text for rich snippets',
          example: '"acceptedAnswer": {"@type": "Answer", "text": "Our return policy allows..."}'
        });
      });
    }

    return this.calculateValidationScore(checklist, 'FAQPage');
  }

  validatePersonSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Person identification', example: '"name": "John Doe"' },
      { property: 'jobTitle', required: false, present: !!schema.jobTitle, impact: 'Professional role identification', example: '"jobTitle": "Software Engineer"' },
      { property: 'worksFor', required: false, present: !!schema.worksFor, impact: 'Employer association', example: '"worksFor": {"@type": "Organization", "name": "Company Name"}' },
      { property: 'url', required: false, present: !!schema.url, impact: 'Personal or professional website', example: '"url": "https://www.johndoe.com"' },
      { property: 'image', required: false, present: !!schema.image, impact: 'Profile photo for rich snippets', example: '"image": "https://www.example.com/john-doe.jpg"' },
      { property: 'sameAs', required: false, present: !!schema.sameAs, impact: 'Social media profile links', example: '"sameAs": ["https://twitter.com/johndoe", "https://linkedin.com/in/johndoe"]' },
      { property: 'email', required: false, present: !!schema.email, impact: 'Contact information', example: '"email": "john@example.com"' },
      { property: 'telephone', required: false, present: !!schema.telephone, impact: 'Contact information', example: '"telephone": "+1-555-555-5555"' }
    ];

    return this.calculateValidationScore(checklist, 'Person');
  }

  validateEventSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Event name in search results', example: '"name": "Concert at Madison Square Garden"' },
      { property: 'startDate', required: true, present: !!schema.startDate, impact: 'Event date for rich snippets', example: '"startDate": "2024-07-01T19:00:00Z"' },
      { property: 'location', required: true, present: !!schema.location, impact: 'Event location for maps integration', example: '"location": {"@type": "Place", "name": "Madison Square Garden", "address": "New York, NY"}' },
      { property: 'endDate', required: false, present: !!schema.endDate, impact: 'Event duration information', example: '"endDate": "2024-07-01T23:00:00Z"' },
      { property: 'description', required: false, present: !!schema.description, impact: 'Event details for search results', example: '"description": "An amazing concert featuring..."' },
      { property: 'image', required: false, present: !!schema.image, impact: 'Event image in rich snippets', example: '"image": "https://www.example.com/event-image.jpg"' },
      { property: 'offers', required: false, present: !!schema.offers, impact: 'Ticket pricing information', example: '"offers": {"@type": "Offer", "price": "50.00", "priceCurrency": "USD", "url": "https://www.example.com/tickets"}' },
      { property: 'organizer', required: false, present: !!schema.organizer, impact: 'Event organizer information', example: '"organizer": {"@type": "Organization", "name": "Event Company"}' }
    ];

    return this.calculateValidationScore(checklist, 'Event');
  }

  validateGenericSchema(schema) {
    const checklist = [
      { property: '@type', required: true, present: !!schema['@type'], impact: 'Schema type identification', example: `"@type": "${schema['@type'] || 'SchemaType'}"` },
      { property: '@context', required: true, present: !!schema['@context'], impact: 'Schema.org context declaration', example: '"@context": "https://schema.org"' },
      { property: 'name', required: false, present: !!schema.name, impact: 'Entity name identification', example: '"name": "Entity Name"' },
      { property: 'description', required: false, present: !!schema.description, impact: 'Entity description', example: '"description": "Description of the entity"' }
    ];

    return this.calculateValidationScore(checklist, schema['@type'] || 'Generic');
  }

  calculateValidationScore(checklist, schemaType) {
    let score = 0;
    let maxScore = 0;

    checklist.forEach(item => {
      const weight = item.required ? 3 : 1;
      maxScore += weight;
      if (item.present) {
        score += weight;
      }
    });

    const completeness = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

    return {
      type: schemaType,
      checklist: checklist,
      score: score,
      maxScore: maxScore,
      completeness: completeness,
      grade: this.getGrade(completeness),
      recommendations: this.getSchemaRecommendations(checklist)
    };
  }

  getGrade(completeness) {
    if (completeness >= 90) return 'A';
    if (completeness >= 80) return 'B';
    if (completeness >= 70) return 'C';
    if (completeness >= 60) return 'D';
    return 'F';
  }

  getSchemaRecommendations(checklist) {
    const missing = checklist.filter(item => !item.present);
    const critical = missing.filter(item => item.required);
    const recommended = missing.filter(item => !item.required);

    return {
      critical: critical,
      recommended: recommended,
      totalMissing: missing.length
    };
  }

  // Placeholder methods for other schema types
  validateWebSiteSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Website name identification', example: '"name": "Your Website Name"' },
      { property: 'url', required: true, present: !!schema.url, impact: 'Website URL declaration', example: '"url": "https://www.yoursite.com"' },
      { property: 'potentialAction', required: false, present: !!schema.potentialAction, impact: 'Enables search box rich snippet', example: '"potentialAction": {"@type": "SearchAction", "target": "https://www.yoursite.com/search?q={search_term_string}", "query-input": "required name=search_term_string"}' }
    ];
    return this.calculateValidationScore(checklist, 'WebSite');
  }

  validateWebApplicationSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Application name for app stores and search', example: '"name": "Your App Name"' },
      { property: 'url', required: true, present: !!schema.url, impact: 'Application URL or homepage', example: '"url": "https://www.yourapp.com"' },
      { property: 'description', required: true, present: !!schema.description, impact: 'Application description for discovery', example: '"description": "A powerful web application for..."' },
      { property: 'applicationCategory', required: false, present: !!schema.applicationCategory, impact: 'App category classification', example: '"applicationCategory": "BusinessApplication"' },
      { property: 'operatingSystem', required: false, present: !!schema.operatingSystem, impact: 'Supported operating systems', example: '"operatingSystem": "All"' },
      { property: 'browserRequirements', required: false, present: !!schema.browserRequirements, impact: 'Browser compatibility information', example: '"browserRequirements": "Requires HTML5 support"' },
      { property: 'screenshot', required: false, present: !!schema.screenshot, impact: 'Application screenshots for listings', example: '"screenshot": "https://www.yourapp.com/screenshot.png"' },
      { property: 'author', required: false, present: !!schema.author, impact: 'Application developer information', example: '"author": {"@type": "Organization", "name": "Your Company"}' },
      { property: 'offers', required: false, present: !!schema.offers, impact: 'Pricing and availability information', example: '"offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}' }
    ];
    return this.calculateValidationScore(checklist, 'WebApplication');
  }

  validateBreadcrumbSchema(schema) {
    const checklist = [
      { property: 'itemListElement', required: true, present: !!schema.itemListElement, impact: 'Breadcrumb navigation structure', example: '"itemListElement": [{"@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.yoursite.com"}]' }
    ];
    return this.calculateValidationScore(checklist, 'BreadcrumbList');
  }

  validateLocalBusinessSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Business name identification', example: '"name": "Your Business Name"' },
      { property: 'address', required: true, present: !!schema.address, impact: 'Critical for local search', example: '"address": {"@type": "PostalAddress", "streetAddress": "123 Main St", "addressLocality": "City", "addressRegion": "State", "postalCode": "12345"}' },
      { property: 'telephone', required: false, present: !!schema.telephone, impact: 'Click-to-call functionality', example: '"telephone": "+1-555-555-5555"' },
      { property: 'openingHours', required: false, present: !!schema.openingHours, impact: 'Business hours display', example: '"openingHours": "Mo-Fr 09:00-17:00"' }
    ];
    return this.calculateValidationScore(checklist, 'LocalBusiness');
  }

  validateReviewSchema(schema) {
    const checklist = [
      { property: 'reviewRating', required: true, present: !!schema.reviewRating, impact: 'Star rating display', example: '"reviewRating": {"@type": "Rating", "ratingValue": "5", "bestRating": "5"}' },
      { property: 'author', required: true, present: !!schema.author, impact: 'Review author identification', example: '"author": {"@type": "Person", "name": "John Doe"}' },
      { property: 'reviewBody', required: false, present: !!schema.reviewBody, impact: 'Review content', example: '"reviewBody": "This is an excellent product..."' }
    ];
    return this.calculateValidationScore(checklist, 'Review');
  }

  validateVideoObjectSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Video title', example: '"name": "How to Use Our Product"' },
      { property: 'description', required: true, present: !!schema.description, impact: 'Video description', example: '"description": "Learn how to use our product effectively"' },
      { property: 'thumbnailUrl', required: true, present: !!schema.thumbnailUrl, impact: 'Video thumbnail image', example: '"thumbnailUrl": "https://www.yoursite.com/video-thumbnail.jpg"' },
      { property: 'uploadDate', required: true, present: !!schema.uploadDate, impact: 'Video publication date', example: '"uploadDate": "2024-01-01T00:00:00Z"' }
    ];
    return this.calculateValidationScore(checklist, 'VideoObject');
  }

  validateJobPostingSchema(schema) {
    const checklist = [
      { property: 'title', required: true, present: !!schema.title, impact: 'Job title in search results', example: '"title": "Software Engineer"' },
      { property: 'description', required: true, present: !!schema.description, impact: 'Job description', example: '"description": "We are looking for a skilled software engineer..."' },
      { property: 'hiringOrganization', required: true, present: !!schema.hiringOrganization, impact: 'Employer information', example: '"hiringOrganization": {"@type": "Organization", "name": "Your Company"}' },
      { property: 'jobLocation', required: true, present: !!schema.jobLocation, impact: 'Job location information', example: '"jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress", "addressLocality": "San Francisco", "addressRegion": "CA"}}' }
    ];
    return this.calculateValidationScore(checklist, 'JobPosting');
  }

  validateRecipeSchema(schema) {
    const checklist = [
      { property: 'name', required: true, present: !!schema.name, impact: 'Recipe name for search results', example: '"name": "Chocolate Chip Cookies"' },
      { property: 'description', required: true, present: !!schema.description, impact: 'Recipe description for rich snippets', example: '"description": "Delicious homemade chocolate chip cookies"' },
      { property: 'image', required: true, present: !!schema.image, impact: 'Recipe image in search results', example: '"image": "https://www.yoursite.com/recipe-image.jpg"' },
      { property: 'author', required: true, present: !!schema.author, impact: 'Recipe author identification', example: '"author": {"@type": "Person", "name": "Chef John"}' },
      { property: 'datePublished', required: false, present: !!schema.datePublished, impact: 'Recipe publication date', example: '"datePublished": "2024-01-01T00:00:00Z"' },
      { property: 'prepTime', required: false, present: !!schema.prepTime, impact: 'Preparation time display', example: '"prepTime": "PT15M"' },
      { property: 'cookTime', required: false, present: !!schema.cookTime, impact: 'Cooking time display', example: '"cookTime": "PT30M"' },
      { property: 'totalTime', required: false, present: !!schema.totalTime, impact: 'Total time calculation', example: '"totalTime": "PT45M"' },
      { property: 'recipeYield', required: false, present: !!schema.recipeYield, impact: 'Recipe serving size', example: '"recipeYield": "12 cookies"' },
      { property: 'recipeIngredient', required: false, present: !!schema.recipeIngredient, impact: 'Ingredient list for rich snippets', example: '"recipeIngredient": ["2 cups flour", "1 cup sugar"]' },
      { property: 'recipeInstructions', required: false, present: !!schema.recipeInstructions, impact: 'Step-by-step instructions', example: '"recipeInstructions": [{"@type": "HowToStep", "text": "Mix ingredients"}]' },
      { property: 'nutrition', required: false, present: !!schema.nutrition, impact: 'Nutritional information display', example: '"nutrition": {"@type": "NutritionInformation", "calories": "150 calories"}' },
      { property: 'aggregateRating', required: false, present: !!schema.aggregateRating, impact: 'Star ratings in search results', example: '"aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.5", "reviewCount": "89"}' }
    ];
    return this.calculateValidationScore(checklist, 'Recipe');
  }

  async analyzePWA($, baseUrl) {
    const pwaData = {
      hasManifest: false,
      manifestUrl: null,
      manifestData: null,
      manifestErrors: [],
      hasServiceWorker: false,
      serviceWorkerUrls: [],
      metaTags: {
        themeColor: null,
        appleWebAppCapable: false,
        appleWebAppStatusBarStyle: null,
        appleWebAppTitle: null,
        appleTouchIcons: [],
        msapplicationConfig: null,
        msapplicationTileColor: null,
        msapplicationTileImage: null
      },
      capabilities: {
        isInstallable: false,
        hasOfflineCapability: false,
        hasStartUrl: false,
        hasDisplay: false,
        hasIcons: false,
        hasValidOrientation: false,
        hasValidThemeColor: false,
        hasValidBackgroundColor: false
      },
      icons: [],
      features: {
        pushNotifications: false,
        backgroundSync: false,
        geolocation: false,
        camera: false,
        deviceOrientation: false,
        fullscreen: false,
        webShare: false
      },
      score: 0,
      grade: 'F',
      recommendations: []
    };

    // Check for Web App Manifest
    const manifestLink = $('link[rel="manifest"]').first();
    if (manifestLink.length > 0) {
      pwaData.hasManifest = true;
      pwaData.manifestUrl = this.resolveUrl(manifestLink.attr('href'), baseUrl);
      
      try {
        // Try to fetch and parse manifest
        const manifestResponse = await axios.get(pwaData.manifestUrl, { timeout: 5000 });
        pwaData.manifestData = JSON.parse(manifestResponse.data);
        this.validateManifest(pwaData);
      } catch (error) {
        pwaData.manifestErrors.push(`Failed to fetch or parse manifest: ${error.message}`);
      }
    }

    // Check for Service Worker registration
    this.checkServiceWorker($, pwaData);

    // Extract PWA-related meta tags
    this.extractPWAMetaTags($, pwaData);

    // Check for PWA capabilities
    this.analyzePWACapabilities(pwaData);

    // Check for PWA features in JavaScript
    this.checkPWAFeatures($, pwaData);

    // Calculate PWA score and grade
    this.calculatePWAScore(pwaData);

    // Generate recommendations
    this.generatePWARecommendations(pwaData);

    return pwaData;
  }

  validateManifest(pwaData) {
    const manifest = pwaData.manifestData;
    
    if (!manifest) return;

    // Check required properties
    if (manifest.name || manifest.short_name) {
      pwaData.capabilities.hasValidName = true;
    } else {
      pwaData.manifestErrors.push('Missing required "name" or "short_name" property');
    }

    if (manifest.start_url) {
      pwaData.capabilities.hasStartUrl = true;
    } else {
      pwaData.manifestErrors.push('Missing "start_url" property');
    }

    if (manifest.display && ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) {
      pwaData.capabilities.hasDisplay = true;
    } else {
      pwaData.manifestErrors.push('Missing or invalid "display" property (should be standalone, fullscreen, or minimal-ui)');
    }

    if (manifest.icons && Array.isArray(manifest.icons) && manifest.icons.length > 0) {
      pwaData.capabilities.hasIcons = true;
      pwaData.icons = manifest.icons;
      
      // Check for required icon sizes
      const requiredSizes = ['192x192', '512x512'];
      const availableSizes = manifest.icons.map(icon => icon.sizes).filter(Boolean);
      
      requiredSizes.forEach(size => {
        if (!availableSizes.some(iconSize => iconSize.includes(size))) {
          pwaData.manifestErrors.push(`Missing icon with size ${size}`);
        }
      });
    } else {
      pwaData.manifestErrors.push('Missing or invalid "icons" array');
    }

    if (manifest.theme_color) {
      pwaData.capabilities.hasValidThemeColor = true;
    }

    if (manifest.background_color) {
      pwaData.capabilities.hasValidBackgroundColor = true;
    }

    if (manifest.orientation) {
      pwaData.capabilities.hasValidOrientation = true;
    }

    // Check if PWA is installable
    const hasRequiredFields = pwaData.capabilities.hasValidName && 
                              pwaData.capabilities.hasStartUrl && 
                              pwaData.capabilities.hasDisplay && 
                              pwaData.capabilities.hasIcons;
    
    pwaData.capabilities.isInstallable = hasRequiredFields && pwaData.hasServiceWorker;
  }

  checkServiceWorker($, pwaData) {
    // Check for service worker registration in script tags
    $('script').each((i, script) => {
      const scriptContent = $(script).html() || '';
      
      if (scriptContent.includes('navigator.serviceWorker.register') || 
          scriptContent.includes('serviceWorker.register')) {
        pwaData.hasServiceWorker = true;
        
        // Try to extract service worker URLs
        const swMatches = scriptContent.match(/register\s*\(\s*['"`]([^'"`]+)['"`]/g);
        if (swMatches) {
          swMatches.forEach(match => {
            const url = match.match(/['"`]([^'"`]+)['"`]/);
            if (url && url[1]) {
              pwaData.serviceWorkerUrls.push(url[1]);
            }
          });
        }
      }
    });

    // Check for common service worker file names
    const commonSWNames = ['sw.js', 'service-worker.js', 'serviceworker.js', 'pwa-sw.js'];
    // Note: We can't actually fetch these without making additional requests
    // This is a basic check for registration in the HTML
  }

  extractPWAMetaTags($, pwaData) {
    // Theme color
    const themeColor = $('meta[name="theme-color"]').attr('content');
    if (themeColor) {
      pwaData.metaTags.themeColor = themeColor;
    }

    // Apple Web App meta tags
    const appleWebAppCapable = $('meta[name="apple-mobile-web-app-capable"]').attr('content');
    pwaData.metaTags.appleWebAppCapable = appleWebAppCapable === 'yes';

    const appleStatusBar = $('meta[name="apple-mobile-web-app-status-bar-style"]').attr('content');
    if (appleStatusBar) {
      pwaData.metaTags.appleWebAppStatusBarStyle = appleStatusBar;
    }

    const appleTitle = $('meta[name="apple-mobile-web-app-title"]').attr('content');
    if (appleTitle) {
      pwaData.metaTags.appleWebAppTitle = appleTitle;
    }

    // Apple Touch Icons
    $('link[rel*="apple-touch-icon"]').each((i, icon) => {
      const $icon = $(icon);
      pwaData.metaTags.appleTouchIcons.push({
        href: $icon.attr('href'),
        sizes: $icon.attr('sizes') || 'default',
        rel: $icon.attr('rel')
      });
    });

    // Microsoft meta tags
    const msConfig = $('meta[name="msapplication-config"]').attr('content');
    if (msConfig) {
      pwaData.metaTags.msapplicationConfig = msConfig;
    }

    const msTileColor = $('meta[name="msapplication-TileColor"]').attr('content');
    if (msTileColor) {
      pwaData.metaTags.msapplicationTileColor = msTileColor;
    }

    const msTileImage = $('meta[name="msapplication-TileImage"]').attr('content');
    if (msTileImage) {
      pwaData.metaTags.msapplicationTileImage = msTileImage;
    }
  }

  analyzePWACapabilities(pwaData) {
    // Check if service worker indicates offline capability
    if (pwaData.hasServiceWorker) {
      pwaData.capabilities.hasOfflineCapability = true;
    }

    // Basic installability check
    const basicRequirements = pwaData.hasManifest && pwaData.hasServiceWorker;
    if (basicRequirements && pwaData.manifestData) {
      pwaData.capabilities.isInstallable = true;
    }
  }

  checkPWAFeatures($, pwaData) {
    // Check for PWA features in script content
    $('script').each((i, script) => {
      const scriptContent = $(script).html() || '';
      
      // Push notifications
      if (scriptContent.includes('Notification.requestPermission') || 
          scriptContent.includes('navigator.serviceWorker.ready')) {
        pwaData.features.pushNotifications = true;
      }

      // Background sync
      if (scriptContent.includes('sync.register') || scriptContent.includes('background-sync')) {
        pwaData.features.backgroundSync = true;
      }

      // Geolocation
      if (scriptContent.includes('navigator.geolocation')) {
        pwaData.features.geolocation = true;
      }

      // Camera
      if (scriptContent.includes('getUserMedia') || scriptContent.includes('navigator.camera')) {
        pwaData.features.camera = true;
      }

      // Device orientation
      if (scriptContent.includes('deviceorientation') || scriptContent.includes('DeviceOrientationEvent')) {
        pwaData.features.deviceOrientation = true;
      }

      // Fullscreen
      if (scriptContent.includes('requestFullscreen') || scriptContent.includes('webkitRequestFullscreen')) {
        pwaData.features.fullscreen = true;
      }

      // Web Share API
      if (scriptContent.includes('navigator.share')) {
        pwaData.features.webShare = true;
      }
    });
  }

  calculatePWAScore(pwaData) {
    let score = 0;

    // Manifest (30 points)
    if (pwaData.hasManifest) {
      score += 15;
      if (pwaData.capabilities.hasValidName) score += 3;
      if (pwaData.capabilities.hasStartUrl) score += 3;
      if (pwaData.capabilities.hasDisplay) score += 3;
      if (pwaData.capabilities.hasIcons) score += 3;
      if (pwaData.capabilities.hasValidThemeColor) score += 2;
      if (pwaData.capabilities.hasValidBackgroundColor) score += 1;
    }

    // Service Worker (25 points)
    if (pwaData.hasServiceWorker) {
      score += 25;
    }

    // Apple/Mobile meta tags (15 points)
    if (pwaData.metaTags.themeColor) score += 3;
    if (pwaData.metaTags.appleWebAppCapable) score += 3;
    if (pwaData.metaTags.appleWebAppTitle) score += 2;
    if (pwaData.metaTags.appleTouchIcons.length > 0) score += 4;
    if (pwaData.metaTags.appleWebAppStatusBarStyle) score += 2;
    if (pwaData.metaTags.msapplicationTileColor) score += 1;

    // PWA Features (20 points)
    if (pwaData.features.pushNotifications) score += 5;
    if (pwaData.features.backgroundSync) score += 4;
    if (pwaData.features.geolocation) score += 3;
    if (pwaData.features.camera) score += 3;
    if (pwaData.features.deviceOrientation) score += 2;
    if (pwaData.features.fullscreen) score += 2;
    if (pwaData.features.webShare) score += 1;

    // Installability (10 points)
    if (pwaData.capabilities.isInstallable) score += 10;

    pwaData.score = Math.min(score, 100);
    
    // Assign grade
    if (pwaData.score >= 90) pwaData.grade = 'A';
    else if (pwaData.score >= 80) pwaData.grade = 'B';
    else if (pwaData.score >= 70) pwaData.grade = 'C';
    else if (pwaData.score >= 60) pwaData.grade = 'D';
    else pwaData.grade = 'F';
  }

  generatePWARecommendations(pwaData) {
    const recommendations = [];

    if (!pwaData.hasManifest) {
      recommendations.push({
        priority: 'high',
        issue: 'Missing Web App Manifest',
        description: 'Add a manifest.json file to enable PWA installation',
        example: 'Create manifest.json and link it with <link rel="manifest" href="/manifest.json">'
      });
    } else if (pwaData.manifestErrors.length > 0) {
      recommendations.push({
        priority: 'high',
        issue: 'Manifest validation errors',
        description: 'Fix manifest file issues to improve PWA compliance',
        details: pwaData.manifestErrors
      });
    }

    if (!pwaData.hasServiceWorker) {
      recommendations.push({
        priority: 'high',
        issue: 'Missing Service Worker',
        description: 'Add a service worker to enable offline functionality and PWA installation',
        example: 'Register service worker: navigator.serviceWorker.register("/sw.js")'
      });
    }

    if (!pwaData.metaTags.themeColor) {
      recommendations.push({
        priority: 'medium',
        issue: 'Missing theme color',
        description: 'Add theme-color meta tag for better mobile experience',
        example: '<meta name="theme-color" content="#000000">'
      });
    }

    if (!pwaData.metaTags.appleWebAppCapable) {
      recommendations.push({
        priority: 'medium',
        issue: 'Missing Apple Web App meta tags',
        description: 'Add Apple-specific meta tags for better iOS experience',
        example: '<meta name="apple-mobile-web-app-capable" content="yes">'
      });
    }

    if (pwaData.metaTags.appleTouchIcons.length === 0) {
      recommendations.push({
        priority: 'medium',
        issue: 'Missing Apple Touch Icons',
        description: 'Add Apple Touch Icons for iOS home screen',
        example: '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">'
      });
    }

    if (!pwaData.features.pushNotifications) {
      recommendations.push({
        priority: 'low',
        issue: 'No push notification support',
        description: 'Consider adding push notifications to improve user engagement',
        example: 'Implement notification permission request and service worker messaging'
      });
    }

    if (!pwaData.capabilities.isInstallable) {
      recommendations.push({
        priority: 'high',
        issue: 'PWA not installable',
        description: 'Ensure all PWA requirements are met for app installation',
        example: 'Verify manifest, service worker, and HTTPS requirements'
      });
    }

    pwaData.recommendations = recommendations;
  }
}

module.exports = SEOCrawler;