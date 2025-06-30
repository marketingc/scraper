#!/usr/bin/env node

const Database = require('./database');
const { AuthManager } = require('./auth');

async function setupProduction() {
  console.log('Setting up SEO Crawler for production...');
  
  try {
    // Initialize database
    const db = new Database();
    const auth = new AuthManager(db);
    
    // Wait for database to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));
    
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