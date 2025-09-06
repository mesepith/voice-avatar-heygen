//This file imports and combines all the specific route handlers.
import express from "express";
import talkRoutes from './talkRoutes.js';
import heygenRoutes from './heygenRoutes.js';

const router = express.Router();

router.use('/talk', talkRoutes);
router.use('/heygen', heygenRoutes);

export default router;