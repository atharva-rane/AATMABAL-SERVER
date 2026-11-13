import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { StorageError, StorageNotConfigured } from '../services/storage';

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ message: 'Not found.' });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ message: 'Invalid input.' });
    return;
  }

  if (err instanceof StorageNotConfigured) {
    res.status(503).json({ message: err.message });
    return;
  }

  if (err instanceof StorageError) {
    res.status(502).json({ message: err.message });
    return;
  }

  // Errors raised by the body parser (too big / not valid JSON).
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    res.status(413).json({ message: 'That is too large. Please use a smaller photo.' });
    return;
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json({ message: 'Invalid input.' });
    return;
  }

  console.error(err);
  res.status(500).json({ message: 'Something went wrong. Please try again.' });
}
