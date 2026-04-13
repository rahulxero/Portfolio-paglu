// middleware.js — Vercel Edge Middleware
// Injects public Supabase URL + anon key into index.html at request time
// This avoids exposing keys in the static file while keeping them accessible client-side

import { NextResponse } from 'next/server';

export const config = {
  matcher: ['/', '/p/:slug*'],
};

export default async function middleware(request) {
  const response = await fetch(request.url, {
    headers: { 'x-skip-middleware': '1' },
  });

  if (!response.headers.get('content-type')?.includes('text/html')) {
    return response;
  }

  let html = await response.text();

  // Replace placeholders with actual env vars
  const supaUrl = process.env.SUPABASE_URL || '';
  const supaKey = process.env.SUPABASE_ANON_KEY || '';

  html = html
    .replace('content="__SUPA_URL__"', `content="${supaUrl}"`)
    .replace('content="__SUPA_KEY__"', `content="${supaKey}"`);

  return new NextResponse(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
