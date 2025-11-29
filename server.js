// backend/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Config ----------
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://intel:intel@webprojone.gsnljtb.mongodb.net/devconnect';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// ---------- MongoDB connect ----------
mongoose.connect(MONGO_URI, { })
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('Mongo connection error:', err);
    process.exit(1);
  });

// ---------- Models (inline) ----------
const { Schema, model } = mongoose;

const UserSchema = new Schema({
  username: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  bio: String,
  avatar: String,
  followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  projects: [{ type: Schema.Types.ObjectId, ref: 'Project' }]
}, { timestamps: true });
const User = model('User', UserSchema);

const ProjectSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: String,
  tech: [String],
  repoUrl: String,
  liveUrl: String,
  likes: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });
const Project = model('Project', ProjectSchema);

const NotificationSchema = new Schema({
  fromUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  toUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['follow', 'like'], required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  read: { type: Boolean, default: false }
}, { timestamps: true });
const Notification = model('Notification', NotificationSchema);

// ---------- Middleware: auth ----------
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

// ---------- Routes ----------

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ----- AUTH -----
// Register
app.post('/api/auth/register', async (req, res) => {
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

// Login
app.post('/api/auth/login', async (req, res) => {
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
      .populate('followers', 'username')
      .populate('following', 'username')
      .populate('projects');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    return res.json(user);
  } catch (err) {
    console.error('GET /api/users/me error', err);
    return res.status(500).send('Server error');
  }
});

// POST /api/users/follow/:id  (toggle)
app.post('/api/users/follow/:id', authMiddleware, async (req, res) => {
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

      // create follow notification
      try {
        await Notification.create({
          fromUser: me.id,
          toUser: other.id,
          type: 'follow'
        });
      } catch (nerr) {
        console.warn('Failed to create follow notification', nerr);
      }

      return res.json({ success: true, following: true });
    }
  } catch (err) {
    console.error('follow error', err);
    return res.status(500).send('Server error');
  }
});

// ----- PROJECTS -----
// POST /api/projects
app.post('/api/projects', authMiddleware, async (req, res) => {
  try {
    const { title, description, tech = [], repoUrl, liveUrl } = req.body;
    if (!title) return res.status(400).json({ msg: 'Title required' });

    const project = new Project({
      owner: req.user.id,
      title,
      description,
      tech,
      repoUrl,
      liveUrl
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

// GET /api/projects
app.get('/api/projects', async (req, res) => {
  try {
    const list = await Project.find()
      .sort({ createdAt: -1 })
      .populate('owner', 'username name avatar');
    return res.json(list);
  } catch (err) {
    console.error('list projects error', err);
    return res.status(500).send('Server error');
  }
});

// POST /api/projects/:id/like (toggle)
app.post('/api/projects/:id/like', authMiddleware, async (req, res) => {
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

      // create like notification for owner (not for self)
      if (project.owner.toString() !== userId.toString()) {
        try {
          await Notification.create({
            fromUser: userId,
            toUser: project.owner,
            type: 'like',
            projectId: project._id
          });
        } catch (nerr) {
          console.warn('Failed to create like notification', nerr);
        }
      }

      return res.json({ success: true, liked: true, likes: project.likes.length });
    }
  } catch (err) {
    console.error('like error', err);
    return res.status(500).send('Server error');
  }
});

// ----- NOTIFICATIONS -----
// GET /api/notifications
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const list = await Notification.find({ toUser: req.user.id })
      .sort({ createdAt: -1 })
      .populate('fromUser', 'username name avatar')
      .populate('projectId', 'title');
    return res.json(list);
  } catch (err) {
    console.error('GET notifications error', err);
    return res.status(500).send('Server error');
  }
});

// PATCH /api/notifications/:id/read
app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const notif = await Notification.findOne({ _id: req.params.id, toUser: req.user.id });
    if (!notif) return res.status(404).json({ msg: 'Notification not found' });
    notif.read = true;
    await notif.save();
    return res.json({ success: true });
  } catch (err) {
    console.error('patch notif read error', err);
    return res.status(500).send('Server error');
  }
});

// ---------- Start server ----------
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
