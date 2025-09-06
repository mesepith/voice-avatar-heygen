//This file handles the MySQL connection pool.
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

db.getConnection()
  .then(connection => {
    console.log("✓ Successfully connected to MySQL database.");
    connection.release();
  })
  .catch(err => {
    console.error("!!! CRITICAL: Failed to connect to MySQL database:", err.message);
  });

export default db;