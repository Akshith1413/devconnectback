// backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { ObjectId } = mongoose.Types;
const stream = require('stream');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Config ----------
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/devconnect';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// ---------- Email Setup ----------
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ---------- MongoDB connect ----------
// ---------- MongoDB connect ----------
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('Mongo connection error:', err);
    process.exit(1);
  });
// ---------- GridFS Setup ----------
let gfs;
const conn = mongoose.connection;
conn.once('open', () => {
  gfs = new GridFSBucket(conn.db, {
    bucketName: 'uploads'
  });
  console.log('GridFS initialized');
});

// ---------- Models ----------
const { Schema, model } = mongoose;

const UserSchema = new Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  bio: { type: String, default: '' },
  avatar: { type: String, default: '' },
  skills: { type: [String], default: [] },
  location: { type: String, default: '' },
  githubUrl: { type: String, default: '' },
  linkedinUrl: { type: String, default: '' },
  website: { type: String, default: '' },
  followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  projects: [{ type: Schema.Types.ObjectId, ref: 'Project' }],
  unreadNotifications: { type: Number, default: 0 },
  emailNotifications: { type: Boolean, default: true },
  settings: {
    theme: { type: String, default: 'light' },
    language: { type: String, default: 'en' }
  }
}, { timestamps: true });

const User = model('User', UserSchema);

const ProjectSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  tech: { type: [String], default: [] },
  repoUrl: { type: String, default: '' },
  liveUrl: { type: String, default: '' },
  images: [{ type: String }], // Store GridFS file IDs
  collaboratorsNeeded: { type: Boolean, default: false },
  collaborationRequest: { type: String, default: '' },
  likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  collaborators: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['active', 'archived', 'completed'], default: 'active' }
}, { timestamps: true });

const Project = model('Project', ProjectSchema);

const NotificationSchema = new Schema({
  fromUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  toUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['follow', 'like', 'collab_request', 'collab_accept', 'message', 'project_comment'], 
    required: true 
  },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
  commentId: { type: Schema.Types.ObjectId, ref: 'Comment' },
  read: { type: Boolean, default: false },
  data: Schema.Types.Mixed
}, { timestamps: true });

const Notification = model('Notification', NotificationSchema);

const MessageSchema = new Schema({
  from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  read: { type: Boolean, default: false },
  roomId: String,
  attachments: [{ type: String }] // GridFS file IDs for attachments
}, { timestamps: true });

const Message = model('Message', MessageSchema);

const CollaborationSchema = new Schema({
  project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  fromUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  toUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: String,
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'rejected', 'withdrawn'], 
    default: 'pending' 
  }
}, { timestamps: true });

const Collaboration = model('Collaboration', CollaborationSchema);

const CommentSchema = new Schema({
  project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  parentComment: { type: Schema.Types.ObjectId, ref: 'Comment' }, // For nested comments
  likes: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

const Comment = model('Comment', CommentSchema);

// ---------- File Upload with GridFS ----------
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('application/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and document files are allowed'), false);
    }
  }
});

// ---------- Rate Limiting ----------
const likeFollowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  message: 'Too many requests, please try again later'
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many attempts, please try again later'
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: 'Too many messages, please slow down'
});

// ---------- Middleware ----------
function authMiddleware(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token) return res.status(401).json({ message: 'No token, authorization denied' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user || decoded;
    next();
  } catch (err) {
    console.error('auth middleware error', err);
    return res.status(401).json({ message: 'Token is not valid' });
  }
}

// ---------- Helper Functions ----------
async function createNotification(data) {
  try {
    const notification = await Notification.create(data);
    
    // Increment unread count for user
    await User.findByIdAndUpdate(data.toUser, { 
      $inc: { unreadNotifications: 1 } 
    });

    // Send email notification if enabled
    const user = await User.findById(data.toUser);
    if (user && user.emailNotifications && user.email) {
      let emailSubject = '';
      let emailText = '';
      
      switch(data.type) {
        case 'follow':
          const follower = await User.findById(data.fromUser);
          emailSubject = `${follower.username} started following you`;
          emailText = `${follower.username} is now following you on DevConnect!`;
          break;
        case 'like':
          const liker = await User.findById(data.fromUser);
          const project = await Project.findById(data.projectId);
          emailSubject = `${liker.username} liked your project`;
          emailText = `${liker.username} liked your project "${project?.title || 'your project'}"`;
          break;
        case 'collab_request':
          const requester = await User.findById(data.fromUser);
          const proj = await Project.findById(data.projectId);
          emailSubject = `${requester.username} wants to collaborate`;
          emailText = `${requester.username} wants to collaborate on your project "${proj?.title || 'your project'}"`;
          break;
      }
      
      if (emailSubject && emailText) {
        transporter.sendMail({
          from: process.env.EMAIL_USER || 'noreply@devconnect.com',
          to: user.email,
          subject: `DevConnect: ${emailSubject}`,
          text: emailText,
          html: `<h3>${emailSubject}</h3><p>${emailText}</p><p>Visit DevConnect to see more: ${process.env.FRONTEND_URL || 'http://localhost:3000'}</p>`
        }).catch(err => console.warn('Email send failed:', err));
      }
    }
    
    return notification;
  } catch (err) {
    console.error('createNotification error:', err);
    throw err;
  }
}

// ---------- File Upload Helper ----------
const uploadToGridFS = (file) => {
  return new Promise((resolve, reject) => {
    if (!file || !file.buffer) {
      reject(new Error('No file provided'));
      return;
    }

    const uploadStream = gfs.openUploadStream(file.originalname, {
      contentType: file.mimetype
    });

    const bufferStream = new stream.PassThrough();
    bufferStream.end(file.buffer);
    
    bufferStream.pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => {
        resolve(uploadStream.id.toString());
      });
  });
};

const getFileUrl = (fileId) => {
  return `/api/files/${fileId}`;
};

// ---------- Routes ----------

// In server.js, add this before the other routes:
app.get('/', (req, res) => {
  res.json({ 
    message: 'DevConnect API is running',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      users: '/api/users',
      projects: '/api/projects',
      messages: '/api/messages',
      notifications: '/api/notifications'
    }
  });
});
// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// File serving endpoint
app.get('/api/files/:id', async (req, res) => {
  try {
    const fileId = new ObjectId(req.params.id);
    const file = await conn.db.collection('uploads.files').findOne({ _id: fileId });
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }

    const downloadStream = gfs.openDownloadStream(fileId);
    
    res.set('Content-Type', file.contentType);
    res.set('Content-Disposition', `inline; filename="${file.filename}"`);
    
    downloadStream.pipe(res);
  } catch (err) {
    console.error('File serve error:', err);
    res.status(500).json({ message: 'Error serving file' });
  }
});

// ----- AUTH -----
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, name, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Please provide username, email and password' });
    }

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) return res.status(400).json({ message: 'User with that email or username already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    const user = new User({ username, name, email, password: hashed });
    await user.save();

    const payload = { user: { id: user.id } };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('register error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if ((!email && !username) || !password) {
      return res.status(400).json({ message: 'Provide email or username and password' });
    }

    const query = email ? { email } : { username };
    const user = await User.findOne(query);
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: 'Invalid credentials' });

    const payload = { user: { id: user.id } };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({ 
      token, 
      user: { 
        id: user.id, 
        username: user.username, 
        email: user.email,
        avatar: user.avatar 
      } 
    });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ----- USERS -----
// GET /api/users/me
app.get('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('followers', 'username name avatar')
      .populate('following', 'username name avatar')
      .populate({
        path: 'projects',
        options: { sort: { createdAt: -1 } }
      });
    
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    const userObj = user.toObject();
    
    // Convert avatar to full URL
    if (userObj.avatar && ObjectId.isValid(userObj.avatar)) {
      userObj.avatar = `${req.protocol}://${req.get('host')}/api/files/${userObj.avatar}`;
    }
    
    return res.json(userObj);
  } catch (err) {
    console.error('GET /api/users/me error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/:id
// In GET /api/users/:id route
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -email')
      .populate('followers', 'username name avatar')
      .populate('following', 'username name avatar')
      .populate({
        path: 'projects',
        match: { status: 'active' },
        options: { sort: { createdAt: -1 } }
      });
    
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    // Convert avatar to full URL if it's a file ID
    const userObj = user.toObject();
    if (userObj.avatar && ObjectId.isValid(userObj.avatar)) {
      userObj.avatar = `${req.protocol}://${req.get('host')}/api/files/${userObj.avatar}`;
    }
    
    // Also convert avatars in followers/following
    if (userObj.followers) {
      userObj.followers = userObj.followers.map(f => ({
        ...f,
        avatar: f.avatar && ObjectId.isValid(f.avatar) 
          ? `${req.protocol}://${req.get('host')}/api/files/${f.avatar}`
          : f.avatar
      }));
    }
    
    if (userObj.following) {
      userObj.following = userObj.following.map(f => ({
        ...f,
        avatar: f.avatar && ObjectId.isValid(f.avatar) 
          ? `${req.protocol}://${req.get('host')}/api/files/${f.avatar}`
          : f.avatar
      }));
    }
    
    return res.json(userObj);
  } catch (err) {
    console.error('GET /api/users/:id error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


// PUT /api/users/me
app.put('/api/users/me', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const updates = req.body;
    
    // Handle avatar upload to GridFS
    if (req.file) {
      try {
        const fileId = await uploadToGridFS(req.file);
        updates.avatar = fileId;
      } catch (uploadErr) {
        console.error('Avatar upload error:', uploadErr);
        return res.status(500).json({ message: 'Failed to upload avatar' });
      }
    }
    
    // Handle skills array
    if (updates.skills && typeof updates.skills === 'string') {
      updates.skills = updates.skills.split(',').map(skill => skill.trim()).filter(skill => skill);
    }
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password');
    
    // Convert avatar to full URL
    const userObj = user.toObject();
    if (userObj.avatar && ObjectId.isValid(userObj.avatar)) {
      userObj.avatar = `${req.protocol}://${req.get('host')}/api/files/${userObj.avatar}`;
    }
    
    return res.json(userObj);
  } catch (err) {
    console.error('Update user error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/search?q=query
app.get('/api/users/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    if (!query.trim()) return res.json([]);
    
    const users = await User.find({
      $or: [
        { username: { $regex: query, $options: 'i' } },
        { name: { $regex: query, $options: 'i' } },
        { bio: { $regex: query, $options: 'i' } },
        { skills: { $regex: query, $options: 'i' } }
      ]
    })
    .select('username name avatar bio skills followers following')
    .limit(20);
    
    // Convert avatars to URLs
    const usersWithUrls = users.map(user => ({
      ...user.toObject(),
      avatar: user.avatar && ObjectId.isValid(user.avatar) ? getFileUrl(user.avatar) : user.avatar
    }));
    
    return res.json(usersWithUrls);
  } catch (err) {
    console.error('User search error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/users/follow/:id
app.post('/api/users/follow/:id', authMiddleware, likeFollowLimiter, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    const other = await User.findById(req.params.id);
    
    if (!other) return res.status(404).json({ message: 'User not found' });
    if (me.id === other.id) return res.status(400).json({ message: 'Cannot follow yourself' });

    const alreadyFollowing = me.following.some(f => f.toString() === other.id.toString());
    
    if (alreadyFollowing) {
      me.following.pull(other.id);
      other.followers.pull(me.id);
      await me.save();
      await other.save();
      return res.json({ success: true, following: false });
    } else {
      me.following.push(other.id);
      other.followers.push(me.id);
      await me.save();
      await other.save();

      // Create follow notification
      const notification = await createNotification({
        fromUser: me._id,
        toUser: other._id,
        type: 'follow'
      });

      // Emit real-time notification
      const populated = await notification.populate('fromUser', 'username name avatar');
      io.to(`user_${other._id}`).emit('notification', populated);

      return res.json({ success: true, following: true });
    }
  } catch (err) {
    console.error('follow error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/projects/tech-stacks', async (req, res) => {
  try {
    // Your tech-stacks aggregation code
    const result = await Project.aggregate([
      { $match: { status: 'active' } },
      { $unwind: '$tech' },
      { $group: { _id: '$tech' } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, tech: '$_id' } }
    ]);
    
    const techStacks = result.map(item => item.tech).filter(Boolean);
    return res.json(techStacks);
  } catch (err) {
    console.error('Tech stacks aggregation error:', err);
    return res.json([]);
  }
});

// ----- PROJECTS -----
// POST /api/projects (with image upload)
app.post('/api/projects', authMiddleware, upload.array('images', 10), async (req, res) => {
  try {
    const { title, description, tech, repoUrl, liveUrl, collaboratorsNeeded, collaborationRequest } = req.body;
    
    if (!title) return res.status(400).json({ message: 'Title is required' });

    // Upload images to GridFS
    let imageIds = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const fileId = await uploadToGridFS(file);
          imageIds.push(fileId);
        } catch (uploadErr) {
          console.error('Image upload error:', uploadErr);
          // Continue with other images
        }
      }
    }

    const project = new Project({
      owner: req.user.id,
      title,
      description: description || '',
      tech: tech ? (Array.isArray(tech) ? tech : tech.split(',').map(t => t.trim()).filter(t => t)) : [],
      repoUrl: repoUrl || '',
      liveUrl: liveUrl || '',
      images: imageIds,
      collaboratorsNeeded: collaboratorsNeeded === 'true' || collaboratorsNeeded === true,
      collaborationRequest: collaborationRequest || ''
    });
    
    await project.save();

    // Add project to user's projects array
    await User.findByIdAndUpdate(req.user.id, { 
      $push: { projects: project._id } 
    });

    const populated = await project.populate('owner', 'username name avatar');
    
    // Convert image IDs to URLs
    const projectObj = populated.toObject();
    projectObj.images = projectObj.images.map(img => getFileUrl(img));
    
    return res.status(201).json(projectObj);
  } catch (err) {
    console.error('create project error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/projects with filtering
app.get('/api/projects', async (req, res) => {
  try {
    const { tech, search, userId, collaboratorsNeeded, page = 1, limit = 20 } = req.query;
    const filter = { status: 'active' };
    
    if (tech && tech !== 'all') {
      filter.tech = { $in: tech.split(',').map(t => t.trim()) };
    }
    
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { 'owner.username': { $regex: search, $options: 'i' } }
      ];
    }
    
    if (userId) {
      filter.owner = userId;
    }
    
    if (collaboratorsNeeded === 'true') {
      filter.collaboratorsNeeded = true;
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const projects = await Project.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('owner', 'username name avatar')
      .populate('collaborators', 'username name avatar');
    
    // Convert image IDs to URLs and avatar URLs
    const projectsWithUrls = projects.map(project => {
      const projectObj = project.toObject();
      projectObj.images = projectObj.images.map(img => getFileUrl(img));
      if (projectObj.owner?.avatar && ObjectId.isValid(projectObj.owner.avatar)) {
        projectObj.owner.avatar = getFileUrl(projectObj.owner.avatar);
      }
      return projectObj;
    });
    
    const total = await Project.countDocuments(filter);
    
    return res.json({
      projects: projectsWithUrls,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) {
    console.error('list projects error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


// GET /api/projects/:id
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('owner', 'username name avatar bio skills')
      .populate('collaborators', 'username name avatar')
      .populate({
        path: 'comments',
        populate: {
          path: 'user',
          select: 'username name avatar'
        },
        options: { sort: { createdAt: -1 } }
      });
    
    if (!project) return res.status(404).json({ message: 'Project not found' });
    
    // Convert image IDs to URLs and avatar URLs
    const projectObj = project.toObject();
    projectObj.images = projectObj.images.map(img => getFileUrl(img));
    if (projectObj.owner?.avatar && ObjectId.isValid(projectObj.owner.avatar)) {
      projectObj.owner.avatar = getFileUrl(projectObj.owner.avatar);
    }
    projectObj.collaborators = projectObj.collaborators.map(collab => ({
      ...collab,
      avatar: collab.avatar && ObjectId.isValid(collab.avatar) ? getFileUrl(collab.avatar) : collab.avatar
    }));
    
    return res.json(projectObj);
  } catch (err) {
    console.error('get project error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


// POST /api/projects/:id/like (toggle with rate limiting)
app.post('/api/projects/:id/like', authMiddleware, likeFollowLimiter, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const userId = req.user.id;
    const alreadyLiked = project.likes.some(l => l.toString() === userId.toString());

    if (alreadyLiked) {
      project.likes.pull(userId);
      await project.save();
      return res.json({ success: true, liked: false, likes: project.likes.length });
    } else {
      project.likes.push(userId);
      await project.save();

      // Create like notification for owner (not for self)
      if (project.owner.toString() !== userId.toString()) {
        const notification = await createNotification({
          fromUser: userId,
          toUser: project.owner,
          type: 'like',
          projectId: project._id
        });

        // Emit real-time notification
        const populated = await notification.populate('fromUser', 'username name avatar').populate('projectId', 'title');
        io.to(`user_${project.owner}`).emit('notification', populated);
      }

      return res.json({ success: true, liked: true, likes: project.likes.length });
    }
  } catch (err) {
    console.error('like error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/projects/:id/collaborate
app.post('/api/projects/:id/collaborate', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    
    if (!project.collaboratorsNeeded) {
      return res.status(400).json({ message: 'This project is not accepting collaborators' });
    }
    
    // Check if user is already a collaborator
    if (project.collaborators.some(c => c.toString() === req.user.id.toString())) {
      return res.status(400).json({ message: 'You are already a collaborator on this project' });
    }
    
    const existingRequest = await Collaboration.findOne({
      project: project._id,
      fromUser: req.user.id,
      toUser: project.owner,
      status: 'pending'
    });
    
    if (existingRequest) {
      return res.status(400).json({ message: 'You already have a pending request for this project' });
    }
    
    const collaboration = new Collaboration({
      project: project._id,
      fromUser: req.user.id,
      toUser: project.owner,
      message: req.body.message || ''
    });
    await collaboration.save();
    
    // Create collaboration request notification
    const notification = await createNotification({
      fromUser: req.user.id,
      toUser: project.owner,
      type: 'collab_request',
      projectId: project._id,
      data: { collaborationId: collaboration._id, message: req.body.message }
    });
    
    const populated = await notification.populate('fromUser', 'username name avatar').populate('projectId', 'title');
    io.to(`user_${project.owner}`).emit('notification', populated);
    
    return res.json({ success: true, collaboration });
  } catch (err) {
    console.error('collaborate error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/projects/:id
app.put('/api/projects/:id', authMiddleware, upload.array('images', 10), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    
    // Check ownership
    if (project.owner.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this project' });
    }
    
    const updates = req.body;
    
    // Handle new image uploads
    if (req.files && req.files.length > 0) {
      const newImageIds = [];
      for (const file of req.files) {
        try {
          const fileId = await uploadToGridFS(file);
          newImageIds.push(fileId);
        } catch (uploadErr) {
          console.error('Image upload error:', uploadErr);
        }
      }
      updates.images = [...project.images, ...newImageIds];
    }
    
    // Handle tech array
    if (updates.tech && typeof updates.tech === 'string') {
      updates.tech = updates.tech.split(',').map(t => t.trim()).filter(t => t);
    }
    
    const updatedProject = await Project.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('owner', 'username name avatar');
    
    // Convert image IDs to URLs
    const projectObj = updatedProject.toObject();
    projectObj.images = projectObj.images.map(img => getFileUrl(img));
    
    return res.json(projectObj);
  } catch (err) {
    console.error('update project error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/projects/:id
app.delete('/api/projects/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    
    // Check ownership
    if (project.owner.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this project' });
    }
    
    // Remove project from user's projects array
    await User.findByIdAndUpdate(req.user.id, {
      $pull: { projects: project._id }
    });
    
    // Archive instead of delete
    project.status = 'archived';
    await project.save();
    
    return res.json({ success: true });
  } catch (err) {
    console.error('delete project error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ----- COMMENTS -----
app.post('/api/projects/:id/comments', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    
    const comment = new Comment({
      project: project._id,
      user: req.user.id,
      text: req.body.text,
      parentComment: req.body.parentComment || null
    });
    
    await comment.save();
    
    // Create notification for project owner if not the commenter
    if (project.owner.toString() !== req.user.id.toString()) {
      await createNotification({
        fromUser: req.user.id,
        toUser: project.owner,
        type: 'project_comment',
        projectId: project._id,
        commentId: comment._id,
        data: { preview: req.body.text.substring(0, 100) }
      });
    }
    
    const populated = await comment.populate('user', 'username name avatar');
    
    return res.status(201).json(populated);
  } catch (err) {
    console.error('create comment error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/comments/:id/like', authMiddleware, likeFollowLimiter, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ message: 'Comment not found' });
    
    const userId = req.user.id;
    const alreadyLiked = comment.likes.some(l => l.toString() === userId.toString());
    
    if (alreadyLiked) {
      comment.likes.pull(userId);
    } else {
      comment.likes.push(userId);
    }
    
    await comment.save();
    
    return res.json({ 
      success: true, 
      liked: !alreadyLiked, 
      likes: comment.likes.length 
    });
  } catch (err) {
    console.error('like comment error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ----- COLLABORATIONS -----
app.put('/api/collaborations/:id/respond', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body; // 'accepted' or 'rejected'
    const collaboration = await Collaboration.findById(req.params.id)
      .populate('project')
      .populate('fromUser', 'username name avatar');
    
    if (!collaboration) return res.status(404).json({ message: 'Collaboration request not found' });
    
    if (collaboration.toUser.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Not authorized to respond to this request' });
    }
    
    collaboration.status = status;
    await collaboration.save();
    
    if (status === 'accepted') {
      await Project.findByIdAndUpdate(collaboration.project._id, {
        $addToSet: { collaborators: collaboration.fromUser._id }
      });
      
      // Create acceptance notification
      const notification = await createNotification({
        fromUser: req.user.id,
        toUser: collaboration.fromUser._id,
        type: 'collab_accept',
        projectId: collaboration.project._id,
        data: { projectTitle: collaboration.project.title }
      });
      
      const populated = await notification.populate('fromUser', 'username name avatar').populate('projectId', 'title');
      io.to(`user_${collaboration.fromUser._id}`).emit('notification', populated);
    }
    
    return res.json({ success: true, collaboration });
  } catch (err) {
    console.error('respond collaboration error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/collaborations/requests', authMiddleware, async (req, res) => {
  try {
    const requests = await Collaboration.find({ 
      $or: [
        { toUser: req.user.id, status: 'pending' },
        { fromUser: req.user.id, status: { $in: ['pending', 'accepted'] } }
      ]
    })
    .populate('fromUser', 'username name avatar')
    .populate('toUser', 'username name avatar')
    .populate('project', 'title')
    .sort({ createdAt: -1 });
    
    return res.json(requests);
  } catch (err) {
    console.error('get collaboration requests error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ----- MESSAGES -----
// GET /api/messages/conversations (FIXED VERSION)
app.get('/api/messages/conversations', authMiddleware, async (req, res) => {
  try {
    const userId = new ObjectId(req.user.id);
    
    // Get unique conversations
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [
            { from: userId },
            { to: userId }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: {
              if: { $eq: ["$from", userId] },
              then: "$to",
              else: "$from"
            }
          },
          lastMessage: { $first: "$$ROOT" },
          unreadCount: {
            $sum: {
              $cond: [
                { 
                  $and: [
                    { $ne: ["$from", userId] },
                    { $eq: ["$read", false] }
                  ]
                },
                1,
                0
              ]
            }
          },
          totalMessages: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $unwind: '$user'
      },
      {
        $project: {
          user: {
            _id: 1,
            username: 1,
            name: 1,
            avatar: 1
          },
          lastMessage: {
            _id: 1,
            text: 1,
            from: 1,
            to: 1,
            read: 1,
            createdAt: 1,
            updatedAt: 1
          },
          unreadCount: 1,
          totalMessages: 1,
          lastActivity: '$lastMessage.createdAt'
        }
      },
      {
        $sort: { lastActivity: -1 }
      }
    ]);
    
    // Convert avatar IDs to URLs
    const conversationsWithUrls = await Promise.all(conversations.map(async (conv) => {
      if (conv.user.avatar && ObjectId.isValid(conv.user.avatar)) {
        conv.user.avatar = getFileUrl(conv.user.avatar);
      }
      return conv;
    }));
    
    return res.json(conversationsWithUrls);
  } catch (err) {
    console.error('get conversations error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/messages/:userId
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const otherUserId = req.params.userId;
    
    // Validate ObjectId
    if (!ObjectId.isValid(otherUserId)) {
      return res.status(400).json({ message: 'Invalid user ID' });
    }
    
    const messages = await Message.find({
      $or: [
        { from: req.user.id, to: otherUserId },
        { from: otherUserId, to: req.user.id }
      ]
    })
    .sort({ createdAt: 1 })
    .populate('from', 'username name avatar')
    .populate('to', 'username name avatar')
    .limit(100);
    
    // Mark messages as read
    await Message.updateMany(
      {
        from: otherUserId,
        to: req.user.id,
        read: false
      },
      { $set: { read: true } }
    );
    
    // Convert avatar IDs to URLs
    const messagesWithUrls = messages.map(msg => {
      const msgObj = msg.toObject();
      if (msgObj.from?.avatar && ObjectId.isValid(msgObj.from.avatar)) {
        msgObj.from.avatar = getFileUrl(msgObj.from.avatar);
      }
      if (msgObj.to?.avatar && ObjectId.isValid(msgObj.to.avatar)) {
        msgObj.to.avatar = getFileUrl(msgObj.to.avatar);
      }
      return msgObj;
    });
    
    return res.json(messagesWithUrls);
  } catch (err) {
    console.error('get messages error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/messages
app.post('/api/messages', authMiddleware, messageLimiter, upload.array('attachments', 5), async (req, res) => {
  try {
    const { to, text } = req.body;
    
    if (!to || !text?.trim()) {
      return res.status(400).json({ message: 'Recipient and message text required' });
    }
    
    // Check if recipient exists
    const recipient = await User.findById(to);
    if (!recipient) {
      return res.status(404).json({ message: 'Recipient not found' });
    }
    
    // Upload attachments to GridFS
    let attachmentIds = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const fileId = await uploadToGridFS(file);
          attachmentIds.push(fileId);
        } catch (uploadErr) {
          console.error('Attachment upload error:', uploadErr);
        }
      }
    }
    
    const message = new Message({
      from: req.user.id,
      to,
      text: text.trim(),
      roomId: [req.user.id, to].sort().join('_'),
      attachments: attachmentIds
    });
    
    await message.save();
    
    const populated = await message.populate('from', 'username name avatar').populate('to', 'username name avatar');
    
    // Convert avatar IDs to URLs
    const msgObj = populated.toObject();
    if (msgObj.from?.avatar && ObjectId.isValid(msgObj.from.avatar)) {
      msgObj.from.avatar = getFileUrl(msgObj.from.avatar);
    }
    if (msgObj.to?.avatar && ObjectId.isValid(msgObj.to.avatar)) {
      msgObj.to.avatar = getFileUrl(msgObj.to.avatar);
    }
    
    // Emit to recipient
    io.to(`user_${to}`).emit('message', msgObj);
    
    // Create notification
    const notification = await createNotification({
      fromUser: req.user.id,
      toUser: to,
      type: 'message',
      messageId: message._id,
      data: { preview: text.length > 50 ? text.substring(0, 50) + '...' : text }
    });
    
    return res.json(msgObj);
  } catch (err) {
    console.error('send message error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /api/messages/:id
app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }
    
    // Check if user is sender
    if (message.from.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this message' });
    }
    
    await Message.deleteOne({ _id: message._id });
    
    return res.json({ success: true });
  } catch (err) {
    console.error('delete message error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ----- NOTIFICATIONS -----
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const notifications = await Notification.find({ toUser: req.user.id })
      .sort({ createdAt: -1 })
      .populate('fromUser', 'username name avatar')
      .populate('projectId', 'title')
      .limit(50);
    
    // Reset unread count
    await User.findByIdAndUpdate(req.user.id, { unreadNotifications: 0 });
    
    // Convert avatar IDs to URLs
    const notificationsWithUrls = notifications.map(notif => {
      const notifObj = notif.toObject();
      if (notifObj.fromUser?.avatar && ObjectId.isValid(notifObj.fromUser.avatar)) {
        notifObj.fromUser.avatar = getFileUrl(notifObj.fromUser.avatar);
      }
      return notifObj;
    });
    
    return res.json(notificationsWithUrls);
  } catch (err) {
    console.error('GET notifications error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const notif = await Notification.findOne({ _id: req.params.id, toUser: req.user.id });
    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    
    notif.read = true;
    await notif.save();
    
    // Decrement unread count
    await User.findByIdAndUpdate(req.user.id, { $inc: { unreadNotifications: -1 } });
    
    return res.json({ success: true });
  } catch (err) {
    console.error('patch notif read error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/notifications/read', authMiddleware, async (req, res) => {
  try {
    const result = await Notification.deleteMany({
      toUser: req.user.id,
      read: true
    });
    
    return res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('delete read notifications error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ----- STATISTICS -----
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [
      projectCount,
      followerCount,
      followingCount,
      likeCount,
      collaborationCount
    ] = await Promise.all([
      Project.countDocuments({ owner: userId, status: 'active' }),
      User.countDocuments({ followers: userId }),
      User.countDocuments({ following: userId }),
      Project.aggregate([
        { $match: { owner: new ObjectId(userId) } },
        { $project: { likesCount: { $size: "$likes" } } },
        { $group: { _id: null, total: { $sum: "$likesCount" } } }
      ]),
      Collaboration.countDocuments({ 
        $or: [
          { fromUser: userId, status: 'accepted' },
          { toUser: userId, status: 'accepted' }
        ]
      })
    ]);
    
    return res.json({
      projects: projectCount,
      followers: followerCount,
      following: followingCount,
      likes: likeCount[0]?.total || 0,
      collaborations: collaborationCount
    });
  } catch (err) {
    console.error('get stats error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ----- FEED -----
app.get('/api/feed', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    // Get projects from followed users
    const projects = await Project.find({
      owner: { $in: user.following },
      status: 'active'
    })
    .sort({ createdAt: -1 })
    .populate('owner', 'username name avatar')
    .limit(50);
    
    // Convert image and avatar IDs to URLs
    const projectsWithUrls = projects.map(project => {
      const projectObj = project.toObject();
      projectObj.images = projectObj.images.map(img => getFileUrl(img));
      if (projectObj.owner?.avatar && ObjectId.isValid(projectObj.owner.avatar)) {
        projectObj.owner.avatar = getFileUrl(projectObj.owner.avatar);
      }
      return projectObj;
    });
    
    return res.json(projectsWithUrls);
  } catch (err) {
    console.error('get feed error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ---------- Cron Job for Cleaning Old Notifications ----------
cron.schedule('0 2 * * *', async () => { // Run at 2 AM daily
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    const result = await Notification.deleteMany({
      read: true,
      createdAt: { $lt: ninetyDaysAgo }
    });
    
    console.log(`Cleaned up ${result.deletedCount} old notifications`);
    
    // Also clean old messages
    const messageResult = await Message.deleteMany({
      createdAt: { $lt: ninetyDaysAgo }
    });
    
    console.log(`Cleaned up ${messageResult.deletedCount} old messages`);
  } catch (err) {
    console.error('Cron job error:', err);
  }
});

// ---------- HTTP + Socket.IO setup ----------
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Socket.IO authentication
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error('Authentication error: no token'));
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.user?.id || decoded.userId;
    next();
  } catch (err) {
    return next(new Error('Authentication error: invalid token'));
  }
});

// Track online users
const onlineUsers = new Map();

io.on('connection', (socket) => {
  const userId = socket.userId;
  
  if (!userId) {
    socket.disconnect();
    return;
  }
  
  console.log('socket connected', socket.id, 'user', userId);
  
  // Add user to online users
  onlineUsers.set(userId, socket.id);
  
  // Join user room
  socket.join(`user_${userId}`);
  
  // Notify others that user is online
  socket.broadcast.emit('user_status', { userId, status: 'online' });
  
  // Handle joining conversation
  socket.on('join_conversation', (otherUserId) => {
    const roomId = [userId, otherUserId].sort().join('_');
    socket.join(`conversation_${roomId}`);
    console.log(`User ${userId} joined conversation with ${otherUserId}`);
  });
  
  // Handle leaving conversation
  socket.on('leave_conversation', (otherUserId) => {
    const roomId = [userId, otherUserId].sort().join('_');
    socket.leave(`conversation_${roomId}`);
  });
  
  // Handle typing indicator
  socket.on('typing', ({ conversationId, isTyping }) => {
    socket.to(`conversation_${conversationId}`).emit('typing', {
      userId,
      isTyping
    });
  });
  
  // Handle call signaling (for future video/audio calls)
  socket.on('call_signal', ({ to, signal, type }) => {
    io.to(`user_${to}`).emit('call_signal', {
      from: userId,
      signal,
      type
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    
    // Remove user from online users
    onlineUsers.delete(userId);
    
    // Notify others that user is offline
    socket.broadcast.emit('user_status', { userId, status: 'offline' });
  });
});

// Helper function to emit to specific user
const emitToUser = (userId, event, data) => {
  const socketId = onlineUsers.get(userId);
  if (socketId) {
    io.to(socketId).emit(event, data);
  }
};

// Make io available globally for notifications
global.io = io;

httpServer.listen(PORT, () => {
  console.log(`Server + sockets listening on ${PORT}`);
  console.log(`GridFS initialized for file storage`);
});