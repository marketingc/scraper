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

      const hashedPassword = await this.hashPassword(password);
      const userId = await this.db.createUser(username, hashedPassword, email);
      return userId;
    } catch (error) {
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
        return null;
      }

      const isValidPassword = await this.verifyPassword(password, user.password);
      if (!isValidPassword) {
        return null;
      }

      // Update last login
      await this.db.updateLastLogin(user.id);

      // Return user without password
      const { password: _, ...userWithoutPassword } = user;
      return userWithoutPassword;
    } catch (error) {
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