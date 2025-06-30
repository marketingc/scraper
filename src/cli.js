#!/usr/bin/env node

const { Command } = require('commander');
const SEOCrawler = require('./crawler');
const SEOReporter = require('./reporter');

const program = new Command();

program
  .name('seo-crawler')
  .description('SEO on-page crawler for analyzing website SEO data')
  .version('1.0.0');

program
  .argument('<url>', 'URL to analyze')
  .option('-f, --format <type>', 'output format (console, json)', 'console')
  .option('-o, --output <file>', 'save report to file')
  .action(async (url, options) => {
    try {
      console.log(`Analyzing: ${url}`);
      console.log('Please wait...\n');

      const crawler = new SEOCrawler();
      const reporter = new SEOReporter();

      const analysis = await crawler.analyzePage(url);
      const report = reporter.generateReport(analysis);

      if (options.format === 'json') {
        const output = JSON.stringify(report, null, 2);
        
        if (options.output) {
          const fs = require('fs');
          fs.writeFileSync(options.output, output);
          console.log(`Report saved to: ${options.output}`);
        } else {
          console.log(output);
        }
      } else {
        const output = reporter.formatConsoleReport(report);
        
        if (options.output) {
          const fs = require('fs');
          fs.writeFileSync(options.output, output);
          console.log(`Report saved to: ${options.output}`);
        } else {
          console.log(output);
        }
      }

    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();