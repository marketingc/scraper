const bcrypt = require('bcryptjs');

class AuthManager {
  constructor(database) {
    this.db = database;
  }

  // Hash password
  async hashPassword(password) {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
  }

  // Verify password
  async verifyPassword(password, hashedPassword) {
    return await bcrypt.compare(password, hashedPassword);
  }

  // Create user
  async createUser(username, password, email = '') {
    try {
      const existingUser = await this.getUserByUsername(username);
      if (existingUser) {
        throw new Error('Username already exists');
      }

      console.log(`🔧 User Creation Debug: Creating user '${username}'`);
      console.log(`🔧 User Creation Debug: Original password length: ${password.length}`);
      console.log(`🔧 User Creation Debug: Original password: '${password}'`);
      
      const hashedPassword = await this.hashPassword(password);
      console.log(`🔧 User Creation Debug: Hashed password length: ${hashedPassword.length}`);
      console.log(`🔧 User Creation Debug: Hashed password starts with: ${hashedPassword.substring(0, 10)}...`);
      
      const userId = await this.db.createUser(username, hashedPassword, email);
      console.log(`🔧 User Creation Debug: User created with ID: ${userId}`);
      
      return userId;
    } catch (error) {
      console.error(`🔧 User Creation Debug: Error creating user:`, error.message);
      throw error;
    }
  }

  // Get user by username
  async getUserByUsername(username) {
    return await this.db.getUserByUsername(username);
  }

  // Get user by ID
  async getUserById(id) {
    return await this.db.getUserById(id);
  }

  // Authenticate user
  async authenticateUser(username, password) {
    try {
      const user = await this.getUserByUsername(username);
      if (!user) {
        console.log(`🔍 Auth Debug: User '${username}' not found`);
        return null;
      }

      console.log(`🔍 Auth Debug: User found - ID: ${user.id}, Username: ${user.username}`);
      console.log(`🔍 Auth Debug: Input password length: ${password.length}`);
      console.log(`🔍 Auth Debug: Stored hash length: ${user.password ? user.password.length : 'NULL'}`);
      console.log(`🔍 Auth Debug: Stored hash starts with: ${user.password ? user.password.substring(0, 10) + '...' : 'NULL'}`);

      const isValidPassword = await this.verifyPassword(password, user.password);
      console.log(`🔍 Auth Debug: Password verification result: ${isValidPassword}`);
      
      if (!isValidPassword) {
        // Let's try to understand why bcrypt is failing
        console.log(`🔍 Auth Debug: Testing bcrypt directly...`);
        try {
          const bcrypt = require('bcryptjs');
          const directResult = await bcrypt.compare(password, user.password);
          console.log(`🔍 Auth Debug: Direct bcrypt.compare result: ${directResult}`);
          
          // Test if the hash is valid format
          const isValidHash = user.password && user.password.startsWith('$2');
          console.log(`🔍 Auth Debug: Hash format valid (starts with $2): ${isValidHash}`);
          
        } catch (bcryptError) {
          console.error(`🔍 Auth Debug: Bcrypt error:`, bcryptError.message);
        }
        
        return null;
      }

      // Update last login
      await this.db.updateLastLogin(user.id);

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;
      return userWithoutPassword;
    } catch (error) {
      console.error(`🔍 Auth Debug: Authentication error:`, error.message);
      throw error;
    }
  }
}

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (req.session && req.session.user) {
    return next();
  } else {
    // Check if it's an AJAX request by looking at headers
    const isAjax = req.xhr || 
                  req.headers['x-requested-with'] === 'XMLHttpRequest' ||
                  req.headers.accept.indexOf('application/json') > -1 ||
                  req.headers['content-type'] === 'application/json';
    
    if (isAjax) {
      return res.status(401).json({ error: 'Authentication required. Please refresh the page and try again.' });
    } else {
      return res.redirect('/login');
    }
  }
};

// Redirect if already logged in
const redirectIfLoggedIn = (req, res, next) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  } else {
    return next();
  }
};

module.exports = { AuthManager, requireAuth, redirectIfLoggedIn };