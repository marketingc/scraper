#!/usr/bin/env node

const Database = require('./database');
const { AuthManager } = require('./auth');

async function setupProduction() {
  console.log('Setting up SEO Crawler for production...');
  
  try {
    // Initialize database
    const db = new Database();
    
    // Wait for database initialization to complete
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds timeout
      
      const checkTables = () => {
        attempts++;
        db.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='url_versions'", (err, row) => {
          if (err) {
            console.error('Database check error:', err);
            if (attempts >= maxAttempts) {
              reject(new Error('Database initialization timeout'));
            } else {
              setTimeout(checkTables, 1000);
            }
          } else if (row) {
            console.log('✅ Database tables initialized successfully');
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
    
    const auth = new AuthManager(db);
    
    // Create admin user if environment variables are provided
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'password';
    
    try {
      // Check if admin user already exists
      const existingUser = await auth.getUserByUsername(adminUsername);
      
      if (!existingUser) {
        await auth.createUser(adminUsername, adminPassword);
        console.log(`✅ Admin user '${adminUsername}' created successfully`);
        console.log(`⚠️  Default password is '${adminPassword}' - please change it after first login!`);
      } else {
        console.log(`ℹ️  Admin user '${adminUsername}' already exists`);
      }
    } catch (error) {
      console.error('Error creating admin user:', error.message);
    }
    
    console.log('✅ Production setup completed successfully');
    
  } catch (error) {
    console.error('❌ Production setup failed:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

// Run setup if this file is executed directly
if (require.main === module) {
  setupProduction();
}

module.exports = setupProduction;