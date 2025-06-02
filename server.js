const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();
const app = express();

// CORS Configuration
const allowedOrigins = [
  "http://localhost:3000",
  "https://trainwithme.in",
  "https://backend-production-d60b.up.railway.app", // Backend URL
  "https://your-frontend.up.railway.app" // Replace with your frontend Railway URL
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`CORS blocked for origin: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  })
);

// Ensure CORS headers for all responses, including errors
app.use((req, res, next) => {
  res.on('finish', () => {
    if (!res.get('Access-Control-Allow-Origin')) {
      res.set('Access-Control-Allow-Origin', allowedOrigins.includes(req.headers.origin) ? req.headers.origin : '*');
    }
  });
  next();
});

// Log all requests for debugging
app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.path}, Origin: ${req.headers.origin || 'none'}, Headers: ${JSON.stringify(req.headers)}`);
  next();
});

app.use(express.json());

// MongoDB Setup
let db;
let mongoConnected = false;

async function connectToMongoDB(uri) {
  if (!uri) {
    console.error("MONGODB_URI is undefined or not set in environment variables");
    throw new Error("MONGODB_URI is not defined");
  }
  console.log("Using MONGODB_URI:", uri.replace(/:([^:@]+)@/, ':****@'));
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    connectTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    retryWrites: true,
    retryReads: true,
    w: 'majority',
    serverApi: { version: '1', strict: true, deprecationErrors: true }
  });
  const maxRetries = 5;
  let attempt = 1;

  while (attempt <= maxRetries) {
    try {
      console.log(`Attempting MongoDB connection (Attempt ${attempt}/${maxRetries})`);
      await client.connect();
      console.log("Connected to MongoDB Atlas");
      db = client.db("trainwithme");
      mongoConnected = true;

      // Create indexes
      await db.collection("mcqs").createIndex({ category: 1, createdAt: -1 });
      await db.collection("users").createIndex({ email: 1 }, { unique: true });
      await db.collection("battleground_rankings").createIndex({ username: 1 }, { unique: true });
      await db.collection("battleground_rankings").createIndex({ score: -1, date: 1 });
      await db.collection("user_seen_mcqs").createIndex(
        { userId: 1, mcqId: 1 },
        { unique: true, background: false }
      );
      await db.collection("reported_mcqs").createIndex(
        { userId: 1, mcqId: 1 },
        { unique: true, background: false }
      );
      await db.collection("current_affairs_articles").createIndex(
        { date: -1, category: 1 },
        { background: false }
      );
      await db.collection("parsed_current_affairs").createIndex(
        { createdAt: -1 },
        { background: false }
      );
      console.log("MongoDB indexes created");

      client.on('error', (err) => {
        console.error("MongoDB client error:", err.message);
        mongoConnected = false;
      });
      client.on('close', () => {
        console.warn("MongoDB connection closed");
        mongoConnected = false;
      });
      return { client, db, mongoConnected };
    } catch (error) {
      console.error(`MongoDB connection attempt ${attempt} failed:`, error.code, error.message, error.stack);
      if (attempt === maxRetries) {
        mongoConnected = false;
        throw error;
      }
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

connectToMongoDB(process.env.MONGODB_URI).then(({ db: database, mongoConnected: connected }) => {
  db = database;
  mongoConnected = connected;
  console.log("MongoDB connection established successfully");
}).catch(err => {
  console.error("MongoDB connection failed permanently:", err.message, err.stack);
  mongoConnected = false;
});

// Category to Book Map
const categoryToBookMap = {
  TamilnaduHistory: { bookName: "Tamilnadu History Book" },
  Spectrum: { bookName: "Spectrum Book" },
  ArtAndCulture: { bookName: "Nitin Singhania Art and Culture Book" },
  FundamentalGeography: { bookName: "NCERT Class 11th Fundamentals of Physical Geography" },
  IndianGeography: { bookName: "NCERT Class 11th Indian Geography" },
  Science: { bookName: "Disha IAS Previous Year Papers (Science Section)" },
  Environment: { bookName: "Shankar IAS Environment Book" },
  Economy: { bookName: "Ramesh Singh Indian Economy Book" },
  CSAT: { bookName: "Disha IAS Previous Year Papers (CSAT Section)" },
  CurrentAffairs: { bookName: "Vision IAS Current Affairs Magazine" },
  PreviousYearPapers: { bookName: "Disha Publication’s UPSC Prelims Previous Year Papers" },
  Polity: { bookName: "Laxmikanth Book" }
};

// Health Check Endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    mongoConnected,
    message: "TrainWithMe Backend API",
    timestamp: new Date().toISOString()
  });
});

// Routes for 404 Handling
app.get("/", (req, res) => {
  res.status(200).json({ status: "OK", message: "TrainWithMe Backend API", mongoConnected });
});
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.get("/favicon.png", (req, res) => res.status(204).end());

// Endpoint to fetch MCQs for a specified book/category for a user
app.post("/user/get-book-mcqs", async (req, res) => {
  try {
    console.log("Request body:", req.body);
    const { userId, book, requestedCount, position } = req.body;

    if (!userId) {
      console.log("Validation failed: Missing userId");
      return res.status(400).json({ error: "Missing userId in request body" });
    }
    if (!book || !categoryToBookMap[book]) {
      console.log(`Validation failed: Invalid or missing book - ${book}`);
      return res.status(400).json({ error: "Missing or invalid book in request body. Valid books are: " + Object.keys(categoryToBookMap).join(", ") });
    }
    if (requestedCount === undefined || typeof requestedCount !== "number") {
      console.log(`Validation failed: Invalid requestedCount - ${requestedCount}`);
      return res.status(400).json({ error: "Missing or invalid requestedCount in request body" });
    }
    if (requestedCount !== 0 && requestedCount <= 0) {
      console.log(`Validation failed: requestedCount must be positive - ${requestedCount}`);
      return res.status(400).json({ error: "requestedCount must be a positive number or 0 for LAW mode" });
    }
    if (position !== undefined && (typeof position !== "number" || position < 0)) {
      console.log(`Validation failed: Invalid position - ${position}`);
      return res.status(400).json({ error: "Position must be a non-negative number" });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const category = book;

    const seenMcqs = await db.collection("user_seen_mcqs")
      .find({ userId })
      .toArray();
    const seenMcqIds = seenMcqs.map(entry => entry.mcqId);

    const categoryMcqs = await db.collection("mcqs")
      .find({ category })
      .toArray();
    const categoryMcqIds = categoryMcqs.map(mcq => mcq._id.toString());

    const seenCategoryMcqIds = seenMcqIds.filter(id => categoryMcqIds.includes(id));

    let mcqs;
    if (requestedCount === 0) {
      const query = {
        category,
        _id: { $nin: seenCategoryMcqIds.map(id => new ObjectId(id)) }
      };
      const options = {
        sort: { createdAt: -1 }
      };
      if (position !== undefined) {
        options.skip = position;
        options.limit = 1;
      } else {
        options.limit = 1;
      }
      mcqs = await db.collection("mcqs")
        .find(query, options)
        .toArray();
      console.log(`LAW mode: Fetched ${mcqs.length} MCQ(s) at position ${position !== undefined ? position : 0} for user ${userId} in category ${category}`);
    } else {
      mcqs = await db.collection("mcqs")
        .find({
          category,
          _id: { $nin: seenCategoryMcqIds.map(id => new ObjectId(id)) }
        })
        .sort({ createdAt: -1 })
        .toArray();

      if (mcqs.length < requestedCount) {
        console.log(`Not enough unseen MCQs (${mcqs.length}/${requestedCount}) for user ${userId} in category ${category}. Resetting seen MCQs.`);
        await db.collection("user_seen_mcqs").deleteMany({
          userId,
          mcqId: { $in: seenCategoryMcqIds }
        });
        console.log(`Reset ${seenCategoryMcqIds.length} seen MCQs for user ${userId} in category ${category}.`);

        mcqs = await db.collection("mcqs")
          .find({ category })
          .sort({ createdAt: -1 })
          .limit(requestedCount)
          .toArray();
      } else {
        mcqs = mcqs.slice(0, requestedCount);
      }
    }

    if (mcqs.length === 0) {
      return res.status(404).json({ error: `No MCQs available for category ${category}.` });
    }

    console.log(`Fetched ${mcqs.length} MCQs for user ${userId} (requested: ${requestedCount === 0 ? 'one' : requestedCount}) in category ${category}`);
    res.status(200).json({ mcqs });
  } catch (error) {
    console.error("Error fetching user MCQs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch MCQs", details: error.message });
  }
});

// Endpoint to mark MCQs as seen by a user
app.post("/user/mark-mcqs-seen", async (req, res) => {
  try {
    const { userId, mcqIds } = req.body;
    if (!userId || !mcqIds || !Array.isArray(mcqIds)) {
      return res.status(400).json({ error: "Missing or invalid userId or mcqIds in request body" });
    }

    if (!mongoConnected || !db) {
      return res.status(503).json({ error: "Database not connected" });
    }

    const seenDocs = mcqIds.map(mcqId => ({
      userId,
      mcqId,
      seenAt: new Date()
    }));

    await db.collection("user_seen_mcqs").insertMany(seenDocs, { ordered: false }).catch(err => {
      if (err.code !== 11000) throw err;
    });

    console.log(`Marked ${mcqIds.length} MCQs as seen for user ${userId}`);
    res.status(200).json({ message: "MCQs marked as seen" });
  } catch (error) {
    console.error("Error marking MCQs as seen:", error.message, error.stack);
    res.status(500).json({ error: "Failed to mark MCQs as seen", details: error.message });
  }
});

// Endpoint to report an MCQ
app.post("/user/report-mcq", async (req, res) => {
  try {
    const { userId, mcqId, mcq } = req.body;
    if (!userId || !mcqId || !mcq) {
      return res.status(400).json({ error: "Missing userId, mcqId, or mcq in request body" });
    }

    if (!mongoConnected || !db) {
      return res.status(503).json({ error: "Database not connected" });
    }

    const reportDoc = {
      userId,
      mcqId,
      mcq,
      reportedAt: new Date()
    };

    await db.collection("reported_mcqs").insertOne(reportDoc);
    console.log(`Reported MCQ ${mcqId} by user ${userId}`);
    res.status(200).json({ message: "MCQ reported successfully" });
  } catch (error) {
    console.error("Error reporting MCQ:", error.message, error.stack);
    if (error.code === 11000) {
      return res.status(400).json({ error: "This MCQ has already been reported by this user" });
    }
    res.status(500).json({ error: "Failed to report MCQ", details: error.message });
  }
});

// Endpoint for admin to update an MCQ
app.post("/admin/update-mcq", async (req, res) => {
  try {
    const { mcqId, updatedMcq } = req.body;
    if (!mcqId || !updatedMcq) {
      return res.status(400).json({ error: "Missing mcqId or updatedMcq in request body" });
    }

    if (!mongoConnected || !db) {
      return res.status(503).json({ error: "Database not connected" });
    }

    const updateResult = await db.collection("mcqs").updateOne(
      { _id: new ObjectId(mcqId) },
      { $set: { mcq: updatedMcq, chapter: updatedMcq.chapter } }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "MCQ not found in mcqs collection" });
    }

    await db.collection("reported_mcqs").deleteOne({ mcqId });

    console.log(`Updated MCQ ${mcqId} and removed from reported_mcqs`);
    res.status(200).json({ message: "MCQ updated and removed from reported_mcqs successfully" });
  } catch (error) {
    console.error("Error updating MCQ:", error.message, error.stack);
    res.status(500).json({ error: "Failed to update MCQ", details: error.message });
  }
});

// Save user data with normalized email
app.post("/save-user", async (req, res) => {
  try {
    const { email, username } = req.body;
    if (!email || !username) {
      return res.status(400).json({ error: "Missing required fields: email and username" });
    }
    if (!mongoConnected || !db) {
      return res.status(503).json({ error: "Database not connected" });
    }
    const normalizedEmail = email.toLowerCase();
    const userData = {
      email: normalizedEmail,
      username,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection("users").updateOne(
      { email: normalizedEmail },
      { $set: userData },
      { upsert: true }
    );
    console.log(`Saved/Updated user: ${normalizedEmail}, username: ${username}`);
    res.status(200).json({ message: "User saved successfully" });
  } catch (error) {
    console.error(`Error saving user:`, error.message, error.stack);
    res.status(error.code === 11000 ? 400 : 500).json({
      error: error.code === 11000 ? "User with this email exists" : "Failed to save user",
      details: error.message
    });
  }
});

// Fetch user info for debugging
app.post("/user/info", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Missing email in request body" });
    }
    if (!mongoConnected || !db) {
      return res.status(503).json({ error: "Database not connected" });
    }
    const normalizedEmail = email.toLowerCase();
    const user = await db.collection("users").findOne(
      { email: normalizedEmail },
      { projection: { email: 1, username: 1, createdAt: 1, updatedAt: 1, _id: 0 } }
    );
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(200).json({ user });
  } catch (error) {
    console.error("Error fetching user info:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch user info", details: error.message });
  }
});

// Battleground endpoints
app.post("/battleground/submit", async (req, res) => {
  try {
    const { username, score } = req.body;
    if (!username || typeof score !== "number") {
      return res.status(400).json({ error: "Missing or invalid username or score" });
    }
    if (!mongoConnected || !db) {
      return res.status(503).json({ error: "Database not connected" });
    }
    const result = await db.collection("battleground_rankings").updateOne(
      { username },
      { $set: { score, date: new Date() } },
      { upsert: true }
    );
    console.log(`Updated/Inserted score for ${username}: score=${score}`);
    const rankings = await db.collection("battleground_rankings")
      .find({}, { projection: { username: 1, score: 1, _id: 0 } })
      .sort({ score: -1, date: 1 })
      .limit(50)
      .toArray();
    res.status(200).json({ rankings });
  } catch (error) {
    console.error("Error in /battleground/submit:", error.message, error.stack);
    res.status(500).json({ error: "Failed to submit score", details: error.message });
  }
});

app.get("/battleground/leaderboard", async (req, res) => {
  try {
    if (!mongoConnected || !db) {
      return res.status(503).json({ error: "Database not connected" });
    }
    const rankings = await db.collection("battleground_rankings")
      .find({}, { projection: { username: 1, score: 1, _id: 0 } })
      .sort({ score: -1, date: 1 })
      .limit(50)
      .toArray();
    res.status(200).json({ rankings });
  } catch (error) {
    console.error("Error in /battleground/leaderboard:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch leaderboard", details: error.message });
  }
});

// Endpoint to fetch current affairs articles
app.get("/admin/get-current-affairs-articles", async (req, res) => {
  try {
    console.log(`Fetching articles: Query=${JSON.stringify(req.query)}, Origin=${req.headers.origin || 'none'}`);
    if (!mongoConnected || !db) {
      console.error("MongoDB not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const { date, category, page = 1, limit = 10 } = req.query;
    const query = {};
    if (date) query.date = date;
    if (category) query.category = category;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 10);
    const skip = (pageNum - 1) * limitNum;

    console.log(`Querying articles: date=${date || 'ALL'}, category=${category || 'ALL'}, page=${pageNum}, limit=${limitNum}`);

    const articles = await db.collection("current_affairs_articles")
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    const totalArticles = await db.collection("current_affairs_articles").countDocuments(query);

    console.log(`Fetched ${articles.length} articles`);
    res.status(200).json({
      articles,
      totalArticles,
      currentPage: pageNum
    });
  } catch (error) {
    console.error("Error fetching articles:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch articles", details: error.message });
  }
});

// Endpoint to fetch parsed current affairs documents
app.get("/admin/get-parsed-current-affairs", async (req, res) => {
  try {
    console.log(`Fetching parsed documents: Origin=${req.headers.origin || 'none'}`);
    if (!mongoConnected || !db) {
      console.error("MongoDB not connected");
      return res.status(503).json({ error: "Database not connected" });
    }
    const documents = await db.collection("parsed_current_affairs")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    console.log(`Fetched ${documents.length} parsed documents`);
    res.status(200).json({ documents });
  } catch (error) {
    console.error("Error fetching parsed documents:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch parsed documents", details: error.message });
  }
});

// Endpoint to generate current affairs articles
app.post("/admin/generate-current-affairs-article", async (req, res) => {
  try {
    const { documentId } = req.body;
    if (!documentId) {
      return res.status(400).json({ error: "Missing documentId in request body" });
    }
    if (!mongoConnected || !db) {
      console.error("MongoDB not connected");
      return res.status(503).json({ error: "Database not connected" });
    }
    const document = await db.collection("parsed_current_affairs").findOne({ _id: new ObjectId(documentId) });
    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    const articles = [
      {
        heading: document.job_metadata?.title || document.title || "Generated Article",
        content: document.content || "This is a generated article based on the parsed document.",
        imageUrl: document.imageUrl || null,
        date: document.job_metadata?.date || document.date || new Date().toISOString().split('T')[0],
        category: document.category || "General",
        createdAt: new Date()
      }
    ];

    await db.collection("current_affairs_articles").insertMany(articles);
    console.log(`Generated ${articles.length} articles for document ${documentId}`);
    res.status(200).json({ articles });
  } catch (error) {
    console.error("Error generating articles:", error.message, error.stack);
    res.status(500).json({ error: "Failed to generate articles", details: error.message });
  }
});

// Global Error Middleware
app.use((err, req, res, next) => {
  console.error(`Unhandled error: ${err.message}, Stack: ${err.stack}`);
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(req.headers.origin) ? req.headers.origin : '*');
  res.status(500).json({
    error: "Internal server error",
    details: err.message || "An unexpected error occurred"
  });
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});