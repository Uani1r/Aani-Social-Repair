import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { NextFunction, Request, Response } from 'express';

import {
  VOICE_MAX_CONCURRENT_TRANSCODES,
  createVoiceGate,
  readBearerToken,
} from './voiceGate';

function createResponse() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    body: unknown;
    headersSent: boolean;
    locals: Record<string, unknown>;
    status: (code: number) => unknown;
    json: (body: unknown) => unknown;
  };
  res.statusCode = 200;
  res.body = null;
  res.headersSent = false;
  res.locals = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  return res;
}

function createRequest(token?: string) {
  return {
    header: (name: string) => (name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : ''),
  } as unknown as Request;
}

const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

test('the bearer token is read from the authorization header only', () => {
  assert.equal(readBearerToken(createRequest('abc')), 'abc');
  assert.equal(readBearerToken(createRequest()), '');
});

test('a request without a token is rejected before any body is read', async () => {
  const gate = createVoiceGate({ verifyToken: async () => 'user-1' });
  const res = createResponse();
  let nextCalled = false;

  gate.middleware(createRequest(), res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);
  await tick();

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(gate.inFlight(), 0);
  assert.equal(res.locals.voiceUserId, undefined);
});

test('an invalid or expired token is rejected', async () => {
  const gate = createVoiceGate({ verifyToken: async () => null });
  const res = createResponse();
  let nextCalled = false;

  gate.middleware(createRequest('expired'), res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);
  await tick();

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(gate.inFlight(), 0);
});

test('an authenticated request proceeds and holds one conversion slot', async () => {
  const gate = createVoiceGate({ verifyToken: async () => 'user-1' });
  const res = createResponse();
  let nextCalled = false;

  gate.middleware(createRequest('token'), res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);
  await tick();

  assert.equal(nextCalled, true);
  assert.equal(res.locals.voiceUserId, 'user-1');
  assert.equal(gate.inFlight(), 1);

  // إغلاق الاستجابة (نجاح أو فشل قراءة الجسم) يحرّر الحجز
  res.emit('close');
  assert.equal(gate.inFlight(), 0);
});

test('one user cannot exceed the per-window rate limit', async () => {
  const gate = createVoiceGate({ verifyToken: async () => 'user-1', maxPerWindow: 2, maxConcurrent: 5 });
  const codes: number[] = [];

  for (let index = 0; index < 3; index += 1) {
    const res = createResponse();
    gate.middleware(createRequest('token'), res as unknown as Response, (() => undefined) as NextFunction);
    await tick();
    codes.push(res.statusCode);
    res.emit('close');
  }

  assert.deepEqual(codes, [200, 200, 429]);
});

test('concurrent conversions are capped regardless of how many users ask', async () => {
  let user = 0;
  const gate = createVoiceGate({
    verifyToken: async () => `user-${user += 1}`,
    maxPerWindow: 10,
    maxConcurrent: 1,
  });

  const first = createResponse();
  gate.middleware(createRequest('t1'), first as unknown as Response, (() => undefined) as NextFunction);
  await tick();
  assert.equal(gate.inFlight(), 1);
  assert.equal(first.statusCode, 200);

  const second = createResponse();
  gate.middleware(createRequest('t2'), second as unknown as Response, (() => undefined) as NextFunction);
  await tick();
  assert.equal(second.statusCode, 429);

  first.emit('close');
  assert.equal(gate.inFlight(), 0);
  assert.equal(VOICE_MAX_CONCURRENT_TRANSCODES, 2);
});
