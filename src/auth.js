const bcrypt = require('bcryptjs');

class AuthManager {
  constructor(database) {
    this.db = database;
    // Hardcoded credentials
    this.hardcodedUsers = {
      admin: {
        id: 1,
        username: 'admin',
        password: 'Aa456123',
        email: 'admin@example.com',
        created_at: new Date().toISOString(),
        last_login: null
      }
    };
  }

  // Authenticate user with hardcoded credentials
  async authenticateUser(username, password) {
    try {
      console.log(`🔍 Hardcoded Auth: Attempting login for '${username}'`);
      
      const user = this.hardcodedUsers[username];
      if (!user) {
        console.log(`🔍 Hardcoded Auth: User '${username}' not found in hardcoded users`);
        return null;
      }

      console.log(`🔍 Hardcoded Auth: User found - Username: ${user.username}`);
      console.log(`🔍 Hardcoded Auth: Input password: '${password}'`);
      console.log(`🔍 Hardcoded Auth: Expected password: '${user.password}'`);

      const isValidPassword = password === user.password;
      console.log(`🔍 Hardcoded Auth: Password match: ${isValidPassword}`);
      
      if (!isValidPassword) {
        return null;
      }

      // Update last login time
      user.last_login = new Date().toISOString();

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;
      console.log(`🔍 Hardcoded Auth: Login successful for '${username}'`);
      return userWithoutPassword;
    } catch (error) {
      console.error(`🔍 Hardcoded Auth: Authentication error:`, error.message);
      throw error;
    }
  }

  // Get user by username (hardcoded)
  async getUserByUsername(username) {
    const user = this.hardcodedUsers[username];
    return user || null;
  }

  // Get user by ID (hardcoded)
  async getUserById(id) {
    const users = Object.values(this.hardcodedUsers);
    return users.find(user => user.id === id) || null;
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
                  (req.headers.accept && req.headers.accept.indexOf('application/json') > -1) ||
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