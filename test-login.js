#!/usr/bin/env node

// Simple script to test login functionality
const axios = require('axios');

async function testLogin(baseUrl, username, password) {
  console.log(`🔐 Testing login at ${baseUrl}`);
  console.log(`👤 Username: ${username}`);
  console.log(`🔑 Password: ${password ? '*'.repeat(password.length) : 'NOT PROVIDED'}`);
  
  try {
    // First, get the login page to establish a session
    console.log('\n1️⃣ Getting login page...');
    const loginPageResponse = await axios.get(`${baseUrl}/login`, {
      withCredentials: true,
      maxRedirects: 0,
      validateStatus: () => true
    });
    console.log(`   Status: ${loginPageResponse.status}`);
    
    // Extract cookies for session
    const cookies = loginPageResponse.headers['set-cookie'] || [];
    const cookieString = cookies.join('; ');
    
    // Attempt login
    console.log('\n2️⃣ Attempting login...');
    const loginResponse = await axios.post(`${baseUrl}/login`, {
      username: username,
      password: password
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString
      },
      withCredentials: true,
      maxRedirects: 0,
      validateStatus: () => true
    });
    
    console.log(`   Status: ${loginResponse.status}`);
    
    if (loginResponse.status === 302) {
      console.log('✅ Login successful! (Redirect detected)');
      console.log(`   Redirect to: ${loginResponse.headers.location}`);
    } else if (loginResponse.status === 200) {
      if (loginResponse.data.includes('Invalid username or password')) {
        console.log('❌ Login failed: Invalid credentials');
      } else if (loginResponse.data.includes('System is still starting up')) {
        console.log('⏳ Login failed: System still starting up');
      } else {
        console.log('❌ Login failed: Unknown reason');
      }
    } else {
      console.log(`❌ Unexpected status: ${loginResponse.status}`);
    }
    
  } catch (error) {
    console.error('❌ Login test failed:', error.message);
    if (error.response) {
      console.error(`   Response status: ${error.response.status}`);
      console.error(`   Response data: ${error.response.data.substring(0, 200)}...`);
    }
  }
}

// Get command line arguments
const args = process.argv.slice(2);
const baseUrl = args[0] || 'http://localhost:3001';
const username = args[1] || 'admin';
const password = args[2] || 'Aa456123';

testLogin(baseUrl, username, password);