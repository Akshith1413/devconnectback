// backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
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

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ---------- Config ----------
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/devconnect';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
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
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('Mongo connection error:', err);
    process.exit(1);
  });

// ---------- Models ----------
const { Schema, model } = mongoose;

const UserSchema = new Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  bio: String,
  avatar: String,
  skills: [String],
  location: String,
  githubUrl: String,
  linkedinUrl: String,
  website: String,
  followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  projects: [{ type: Schema.Types.ObjectId, ref: 'Project' }],
  unreadNotifications: { type: Number, default: 0 },
  emailNotifications: { type: Boolean, default: true }
}, { timestamps: true });
const User = model('User', UserSchema);

const ProjectSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: String,
  tech: [String],
  repoUrl: String,
  liveUrl: String,
  images: [String],
  collaboratorsNeeded: { type: Boolean, default: false },
  collaborationRequest: String,
  likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  collaborators: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });
const Project = model('Project', ProjectSchema);

const NotificationSchema = new Schema({
  fromUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  toUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['follow', 'like', 'collab_request', 'collab_accept', 'message'], 
    required: true 
  },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
  read: { type: Boolean, default: false },
  data: Schema.Types.Mixed
}, { timestamps: true });
const Notification = model('Notification', NotificationSchema);

const MessageSchema = new Schema({
  from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  read: { type: Boolean, default: false },
  roomId: String // For direct messaging
}, { timestamps: true });
const Message = model('Message', MessageSchema);

const CollaborationSchema = new Schema({
  project: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  fromUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  toUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  message: String,
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'rejected'], 
    default: 'pending' 
  }
}, { timestamps: true });
const Collaboration = model('Collaboration', CollaborationSchema);

// ---------- File Upload ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// ---------- Rate Limiting ----------
const likeFollowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  message: 'Too many requests, please try again later'
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 failed attempts per hour
  message: 'Too many attempts, please try again later'
});

// ---------- Middleware ----------
function authMiddleware(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token) return res.status(401).json({ msg: 'No token, authorization denied' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded.user || decoded;
    next();
  } catch (err) {
    console.error('auth middleware error', err);
    return res.status(401).json({ msg: 'Token is not valid' });
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
    if (user && user.emailNotifications) {
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
          emailText = `${liker.username} liked your project "${project.title}"`;
          break;
        case 'collab_request':
          const requester = await User.findById(data.fromUser);
          const proj = await Project.findById(data.projectId);
          emailSubject = `${requester.username} wants to collaborate`;
          emailText = `${requester.username} wants to collaborate on your project "${proj.title}"`;
          break;
      }
      
      if (emailSubject && emailText) {
        transporter.sendMail({
          from: process.env.EMAIL_USER,
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

// ---------- Routes ----------

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ----- AUTH -----
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, name, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ msg: 'Please provide username, email and password' });

    const exists = await User.findOne({ $or: [{ email }, { username }] });
    if (exists) return res.status(400).json({ msg: 'User with that email or username already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    const user = new User({ username, name, email, password: hashed });
    await user.save();

    const payload = { user: { id: user.id } };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({ token });
  } catch (err) {
    console.error('register error', err);
    return res.status(500).send('Server error');
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if ((!email && !username) || !password) return res.status(400).json({ msg: 'Provide email or username and password' });

    const query = email ? { email } : { username };
    const user = await User.findOne(query);
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ msg: 'Invalid credentials' });

    const payload = { user: { id: user.id } };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return res.json({ token });
  } catch (err) {
    console.error('login error', err);
    return res.status(500).send('Server error');
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
      .populate('projects');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    return res.json(user);
  } catch (err) {
    console.error('GET /api/users/me error', err);
    return res.status(500).send('Server error');
  }
});

// GET /api/users/:id
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('followers', 'username name avatar')
      .populate('following', 'username name avatar')
      .populate({
        path: 'projects',
        populate: { path: 'owner', select: 'username name avatar' }
      });
    if (!user) return res.status(404).json({ msg: 'User not found' });
    return res.json(user);
  } catch (err) {
    console.error('GET /api/users/:id error', err);
    return res.status(500).send('Server error');
  }
});

// PUT /api/users/me
app.put('/api/users/me', authMiddleware, upload.single('avatar'), async (req, res) => {
  try {
    const updates = req.body;
    if (req.file) {
      updates.avatar = `/uploads/${req.file.filename}`;
    }
    
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password');
    
    return res.json(user);
  } catch (err) {
    console.error('Update user error', err);
    return res.status(500).send('Server error');
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
    
    return res.json(users);
  } catch (err) {
    console.error('User search error', err);
    return res.status(500).send('Server error');
  }
});

// POST /api/users/follow/:id (toggle with rate limiting)
app.post('/api/users/follow/:id', authMiddleware, likeFollowLimiter, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    const other = await User.findById(req.params.id);
    if (!other) return res.status(404).json({ msg: 'User not found' });
    if (me.id === other.id) return res.status(400).json({ msg: 'Cannot follow yourself' });

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
    return res.status(500).send('Server error');
  }
});

// ----- PROJECTS -----
// POST /api/projects (with image upload)
app.post('/api/projects', authMiddleware, upload.array('images', 5), async (req, res) => {
  try {
    const { title, description, tech, repoUrl, liveUrl, collaboratorsNeeded, collaborationRequest } = req.body;
    if (!title) return res.status(400).json({ msg: 'Title required' });

    const images = req.files ? req.files.map(file => `/uploads/${file.filename}`) : [];

    const project = new Project({
      owner: req.user.id,
      title,
      description,
      tech: Array.isArray(tech) ? tech : (tech ? tech.split(',').map(t => t.trim()) : []),
      repoUrl,
      liveUrl,
      images,
      collaboratorsNeeded: collaboratorsNeeded === 'true',
      collaborationRequest
    });
    await project.save();

    await User.findByIdAndUpdate(req.user.id, { $push: { projects: project._id } });

    const populated = await project.populate('owner', 'username name avatar');
    return res.status(201).json(populated);
  } catch (err) {
    console.error('create project error', err);
    return res.status(500).send('Server error');
  }
});

// GET /api/projects with filtering
app.get('/api/projects', async (req, res) => {
  try {
    const { tech, search, userId, collaboratorsNeeded } = req.query;
    const filter = {};
    
    if (tech) {
      filter.tech = { $in: tech.split(',') };
    }
    
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (userId) {
      filter.owner = userId;
    }
    
    if (collaboratorsNeeded === 'true') {
      filter.collaboratorsNeeded = true;
    }
    
    const list = await Project.find(filter)
      .sort({ createdAt: -1 })
      .populate('owner', 'username name avatar')
      .populate('collaborators', 'username name avatar');
    return res.json(list);
  } catch (err) {
    console.error('list projects error', err);
    return res.status(500).send('Server error');
  }
});

// GET /api/projects/tech-stacks
app.get('/api/projects/tech-stacks', async (req, res) => {
  try {
    const techStacks = await Project.distinct('tech');
    return res.json(techStacks.filter(Boolean));
  } catch (err) {
    console.error('tech-stacks error', err);
    return res.status(500).send('Server error');
  }
});

// POST /api/projects/:id/like (toggle with rate limiting)
app.post('/api/projects/:id/like', authMiddleware, likeFollowLimiter, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ msg: 'Project not found' });

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
    return res.status(500).send('Server error');
  }
});

// POST /api/projects/:id/collaborate
app.post('/api/projects/:id/collaborate', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ msg: 'Project not found' });
    
    if (!project.collaboratorsNeeded) {
      return res.status(400).json({ msg: 'This project is not accepting collaborators' });
    }
    
    const existingRequest = await Collaboration.findOne({
      project: project._id,
      fromUser: req.user.id,
      toUser: project.owner,
      status: 'pending'
    });
    
    if (existingRequest) {
      return res.status(400).json({ msg: 'You already have a pending request for this project' });
    }
    
    const collaboration = new Collaboration({
      project: project._id,
      fromUser: req.user.id,
      toUser: project.owner,
      message: req.body.message
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
    return res.status(500).send('Server error');
  }
});

// PUT /api/collaborations/:id/respond
app.put('/api/collaborations/:id/respond', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body; // 'accepted' or 'rejected'
    const collaboration = await Collaboration.findById(req.params.id)
      .populate('project')
      .populate('fromUser', 'username name avatar');
    
    if (!collaboration) return res.status(404).json({ msg: 'Collaboration request not found' });
    
    if (collaboration.toUser.toString() !== req.user.id) {
      return res.status(403).json({ msg: 'Not authorized to respond to this request' });
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
    return res.status(500).send('Server error');
  }
});

// ----- MESSAGES -----
// GET /api/messages/:userId
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const messages = await Message.find({
      $or: [
        { from: req.user.id, to: req.params.userId },
        { from: req.params.userId, to: req.user.id }
      ]
    })
    .sort({ createdAt: 1 })
    .populate('from', 'username name avatar')
    .populate('to', 'username name avatar');
    
    return res.json(messages);
  } catch (err) {
    console.error('get messages error', err);
    return res.status(500).send('Server error');
  }
});

// GET /api/messages/conversations
app.get('/api/messages/conversations', authMiddleware, async (req, res) => {
  try {
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [
            { from: mongoose.Types.ObjectId(req.user.id) },
            { to: mongoose.Types.ObjectId(req.user.id) }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$from", mongoose.Types.ObjectId(req.user.id)] },
              "$to",
              "$from"
            ]
          },
          lastMessage: { $first: "$$ROOT" },
          unreadCount: {
            $sum: {
              $cond: [
                { 
                  $and: [
                    { $ne: ["$from", mongoose.Types.ObjectId(req.user.id)] },
                    { $eq: ["$read", false] }
                  ]
                },
                1,
                0
              ]
            }
          }
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
          user: { username: 1, name: 1, avatar: 1 },
          lastMessage: 1,
          unreadCount: 1
        }
      },
      {
        $sort: { 'lastMessage.createdAt': -1 }
      }
    ]);
    
    return res.json(conversations);
  } catch (err) {
    console.error('get conversations error', err);
    return res.status(500).send('Server error');
  }
});

// POST /api/messages
app.post('/api/messages', authMiddleware, async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ msg: 'Recipient and message text required' });
    
    const message = new Message({
      from: req.user.id,
      to,
      text,
      roomId: [req.user.id, to].sort().join('_')
    });
    await message.save();
    
    const populated = await message.populate('from', 'username name avatar').populate('to', 'username name avatar');
    
    // Emit to recipient
    io.to(`user_${to}`).emit('message', populated);
    
    // Create notification
    const notification = await createNotification({
      fromUser: req.user.id,
      toUser: to,
      type: 'message',
      messageId: message._id,
      data: { preview: text.length > 50 ? text.substring(0, 50) + '...' : text }
    });
    
    return res.json(populated);
  } catch (err) {
    console.error('send message error', err);
    return res.status(500).send('Server error');
  }
});

// PUT /api/messages/:id/read
app.put('/api/messages/:id/read', authMiddleware, async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    if (!message) return res.status(404).json({ msg: 'Message not found' });
    
    if (message.to.toString() !== req.user.id) {
      return res.status(403).json({ msg: 'Not authorized' });
    }
    
    message.read = true;
    await message.save();
    
    return res.json({ success: true });
  } catch (err) {
    console.error('mark message read error', err);
    return res.status(500).send('Server error');
  }
});

// ----- NOTIFICATIONS -----
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const list = await Notification.find({ toUser: req.user.id })
      .sort({ createdAt: -1 })
      .populate('fromUser', 'username name avatar')
      .populate('projectId', 'title')
      .limit(50);
    
    // Reset unread count
    await User.findByIdAndUpdate(req.user.id, { unreadNotifications: 0 });
    
    return res.json(list);
  } catch (err) {
    console.error('GET notifications error', err);
    return res.status(500).send('Server error');
  }
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const notif = await Notification.findOne({ _id: req.params.id, toUser: req.user.id });
    if (!notif) return res.status(404).json({ msg: 'Notification not found' });
    notif.read = true;
    await notif.save();
    
    // Decrement unread count
    await User.findByIdAndUpdate(req.user.id, { $inc: { unreadNotifications: -1 } });
    
    return res.json({ success: true });
  } catch (err) {
    console.error('patch notif read error', err);
    return res.status(500).send('Server error');
  }
});

app.delete('/api/notifications/old', authMiddleware, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const result = await Notification.deleteMany({
      toUser: req.user.id,
      createdAt: { $lt: thirtyDaysAgo },
      read: true
    });
    
    return res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error('delete old notifications error', err);
    return res.status(500).send('Server error');
  }
});

// ----- COLLABORATIONS -----
app.get('/api/collaborations/requests', authMiddleware, async (req, res) => {
  try {
    const requests = await Collaboration.find({ toUser: req.user.id, status: 'pending' })
      .populate('fromUser', 'username name avatar')
      .populate('project', 'title')
      .sort({ createdAt: -1 });
    
    return res.json(requests);
  } catch (err) {
    console.error('get collaboration requests error', err);
    return res.status(500).send('Server error');
  }
});

// ---------- Cron Job for Cleaning Old Notifications ----------
cron.schedule('0 0 * * *', async () => {
  try {
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    
    const result = await Notification.deleteMany({
      read: true,
      createdAt: { $lt: sixtyDaysAgo }
    });
    
    console.log(`Cleaned up ${result.deletedCount} old notifications`);
  } catch (err) {
    console.error('Cron job error:', err);
  }
});

// ---------- HTTP + Socket.IO setup ----------
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket.IO authentication
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication error: no token'));
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded.user;
    return next();
  } catch (err) {
    return next(new Error('Authentication error: invalid token'));
  }
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id, 'user', socket.user?.id);

  if (socket.user?.id) {
    socket.join(`user_${socket.user.id}`);
    
    // Join conversation rooms
    socket.on('join_conversation', (otherUserId) => {
      const roomId = [socket.user.id, otherUserId].sort().join('_');
      socket.join(`conversation_${roomId}`);
    });
    
    socket.on('leave_conversation', (otherUserId) => {
      const roomId = [socket.user.id, otherUserId].sort().join('_');
      socket.leave(`conversation_${roomId}`);
    });
    
    socket.on('typing', ({ to, isTyping }) => {
      socket.to(`user_${to}`).emit('typing', { from: socket.user.id, isTyping });
    });
  }

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server + sockets listening on ${PORT}`);
  console.log(`Uploads directory: ${path.join(__dirname, 'uploads')}`);
});