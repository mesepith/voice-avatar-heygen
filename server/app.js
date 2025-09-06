//This file configures the Express application, including CORS and other middleware, and hooks up the API routes.
import express from "express";
import cors from "cors";
import apiRoutes from "./routes/api.js";

const app = express();

const allowedOrigins = [
  'http://localhost:5173',
  'https://demo2.zahiralam.com'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      callback(new Error(msg), false);
    }
  }
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));

// Mount the API routes
app.use('/api', apiRoutes);

export default app;