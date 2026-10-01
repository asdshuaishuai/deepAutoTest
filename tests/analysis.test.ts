/**
 * 分析层（S2 路由发现 / S3 原则提取）：真实 fixture 仓库 → ts-morph 提取 →
 * kernel 人机门落库。验证：准确率、file:line 溯源、幂等重索引、P3、P5。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { indexLocalSource } from '../src/analysis/scan.ts';
import { testKernel } from './helpers.ts';

let cleanupDirs: string[] = [];
afterAll(() => {
  void cleanupDirs; // 临时目录由 OS 清理
});

function fixtureRepo(): string {
  const dir = join(tmpdir(), `dat-fixture-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
  mkdirSync(join(dir, 'prisma'), { recursive: true });

  writeFileSync(
    join(dir, 'src', 'routes', 'orders.ts'),
    `import { Router } from 'express';
export const router = Router();

router.get('/orders', async (req, res) => { res.json({}); });
router.post('/orders', async (req, res) => { res.status(201).json({}); });
router.get('/orders/:id', async (req, res) => { res.json({ id: req.params.id }); });
router.delete('/orders/:id', async (req, res) => { res.status(204).end(); });

// 非惯例接收者 + 无函数处理器 → 应被忽略（多半是数组 .get()）
const arr = [{ get: (i: number) => i }];
const x = arr[0]!.get(0);
void x;
`,
  );

  writeFileSync(
    join(dir, 'src', 'routes', 'users.ts'),
    `import Router from '@koa/router';
const userRouter = new Router();
userRouter.get('/users', (ctx) => { ctx.body = {}; });
userRouter.post('/users', (ctx) => { ctx.status = 201; });
export default userRouter;
`,
  );

  writeFileSync(
    join(dir, 'src', 'orders.controller.ts'),
    `import { Controller, Get, Post, Body } from '@nestjs/common';

@Controller('orders')
export class OrdersController {
  @Get()
  list() { return []; }

  @Post(':id/retry')
  retry(@Body() body: unknown) { return body; }
}
`,
  );

  writeFileSync(
    join(dir, 'src', 'schemas.ts'),
    `import { z } from 'zod';

export const CreateOrderSchema = z.object({
  amount: z.number().int().max(50000),
  note: z.string().min(1).max(200).optional(),
  channel: z.enum(['APP', 'H5', 'MINI']),
  contact: z.string().regex(/^1[3-9]\\\\d{9}$/),
});

export const raw = z.any();
`,
  );

  writeFileSync(
    join(dir, 'src', 'validations.ts'),
    `import Joi from 'joi';

export const PaymentSchema = Joi.object({
  amount: Joi.number().integer().max(100000).required(),
  email: Joi.string().email(),
});
`,
  );

  writeFileSync(
    join(dir, 'src', 'dto.ts'),
    `import { Max, Min, Length, IsEmail, IsIn, IsOptional } from 'class-validator';

export class CreateUserDto {
  @Max(150)
  @Min(0)
  age!: number;

  @Length(2, 20)
  @IsOptional()
  nickname!: string;

  @IsEmail()
  email!: string;

  @IsIn(['MALE', 'FEMALE', 'OTHER'])
  gender!: string;
}
`,
  );

  writeFileSync(
    join(dir, 'prisma', 'schema.prisma'),
    `generator client {
  provider = "prisma-client-js"
}

model User {
  id        Int     @id @default(autoincrement())
  phone     String  @unique @db.VarChar(20)
  realName  String? @db.VarChar(50)
  status    String
  @@unique([status, realName])
}

model Order {
  id     Int  @id
  amount Int  @db.UnsignedInt(11)
}
`,
  );

  cleanupDirs.push(dir);
  return dir;
}

describe('分析层：本地源码索引', () => {
  it('路由发现：Express/Koa/NestJS 提取准确、误报被排除、file:line 溯源', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'fixture', sourceType: 'local', localPath: fixtureRepo() });
    const scan = await indexLocalSource(h.kernel, project.id, project.localPath!);

    expect(scan.frameworks).toContain('express');
    expect(scan.frameworks).toContain('koa');
    expect(scan.frameworks).toContain('nestjs');
    expect(scan.frameworks).toContain('prisma');

    const routes = await h.kernel.call('route:list', { projectId: project.id });
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));

    // Express（惯例接收者 + 处理器 → high）
    // GET /orders 同时存在于 express 路由与 NestJS 控制器——同键路由（真实世界的合法歧义），只断言存在与置信度
    expect(byKey.get('GET /orders')).toMatchObject({ confidence: 'high' });
    expect(byKey.get('POST /orders')).toMatchObject({ framework: 'express' });
    expect(byKey.get('GET /orders/:id')).toBeTruthy();
    expect(byKey.get('DELETE /orders/:id')).toBeTruthy();

    // Koa（@koa/router 默认导入）
    expect(byKey.get('GET /users')).toMatchObject({ framework: 'koa' });
    expect(byKey.get('POST /users')).toBeTruthy();

    // NestJS（前缀合成）
    expect(byKey.get('POST /orders/:id/retry')).toMatchObject({ framework: 'nestjs', confidence: 'high' });
    expect(routes.some((r) => r.framework === 'nestjs' && r.path === '/orders')).toBe(true);

    // 误报排除：数组 .get(0) 不在（其 path 不以 / 开头，被规则排除）
    expect(routes.every((r) => r.path.startsWith('/'))).toBe(true);

    // 溯源：行号都有效
    expect(routes.every((r) => r.handlerLine >= 1)).toBe(true);
    expect(scan.routesInserted).toBe(routes.length);
    h.dispose();
  });

  it('原则提取：zod / joi / class-validator / Prisma → value_json + file:line', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'fixture', sourceType: 'local', localPath: fixtureRepo() });
    await indexLocalSource(h.kernel, project.id, project.localPath!);

    const principles = await h.kernel.call('principle:list', { projectId: project.id });
    const bySubject = new Map(principles.map((p) => [p.subject, p]));

    // zod：数值边界（S3 → S5 的关键接口）；subject 带 schema 变量限定（CreateOrderSchema.amount）
    expect(bySubject.get('CreateOrderSchema.amount')).toMatchObject({
      layer: 'validation',
      confidence: 'high',
      sourceFile: 'src/schemas.ts',
      valueJson: { type: 'number', integer: true, max: 50000 },
    });
    expect(bySubject.get('CreateOrderSchema.amount')!.rule).toContain('≤ 50000');

    // zod：字符串长度
    const note = bySubject.get('CreateOrderSchema.note')!;
    expect(note.valueJson).toMatchObject({ type: 'string', minLength: 1, maxLength: 200, optional: true });

    // zod：枚举
    expect(bySubject.get('CreateOrderSchema.channel')!.valueJson).toMatchObject({ type: 'enum', enum: ['APP', 'H5', 'MINI'] });
    expect(bySubject.get('CreateOrderSchema.channel')!.rule).toContain('APP|H5|MINI');

    // joi
    expect(bySubject.get('PaymentSchema.amount')!.valueJson).toMatchObject({ type: 'number', integer: true, max: 100000 });
    expect(bySubject.get('PaymentSchema.email')!.valueJson).toMatchObject({ email: true });

    // class-validator：ClassName.subject 形态
    expect(bySubject.get('CreateUserDto.age')!.valueJson).toMatchObject({ min: 0, max: 150 });
    expect(bySubject.get('CreateUserDto.email')!.valueJson).toMatchObject({ email: true });
    expect(bySubject.get('CreateUserDto.gender')!.valueJson).toMatchObject({ type: 'enum', enum: ['MALE', 'FEMALE', 'OTHER'] });
    expect(bySubject.get('CreateUserDto.nickname')!.valueJson).toMatchObject({ minLength: 2, maxLength: 20, optional: true });

    // Prisma：持久层
    expect(bySubject.get('User.phone')!.valueJson).toMatchObject({ type: 'string', maxLength: 20, unique: true });
    expect(bySubject.get('User.phone')!.layer).toBe('persistence');
    expect(bySubject.get('Order.amount')!.valueJson).toMatchObject({ type: 'number', integer: true });
    // @@unique 复合唯一成员
    expect(bySubject.get('User.status')!.valueJson).toMatchObject({ unique: true });

    // 溯源非空（03 §2.5：没有溯源的原则无法被验证）
    expect(principles.every((p) => p.sourceFile.length > 0 && p.sourceLine >= 1)).toBe(true);
    h.dispose();
  });

  it('幂等重索引：二次索引不产生重复（去重键）', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'fixture', sourceType: 'local', localPath: fixtureRepo() });
    const first = await indexLocalSource(h.kernel, project.id, project.localPath!);
    const second = await indexLocalSource(h.kernel, project.id, project.localPath!);

    expect(second.routesInserted).toBe(0);
    expect(second.principlesInserted).toBe(0);
    const routes = await h.kernel.call('route:list', { projectId: project.id });
    const principles = await h.kernel.call('principle:list', { projectId: project.id });
    expect(routes.length).toBe(first.routesInserted);
    expect(principles.length).toBe(first.principlesInserted);
    h.dispose();
  });

  it('P3：分析产物全部 proposed；人工采纳/拒绝留痕', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'fixture', sourceType: 'local', localPath: fixtureRepo() });
    await indexLocalSource(h.kernel, project.id, project.localPath!);

    const routes = await h.kernel.call('route:list', { projectId: project.id });
    expect(routes.every((r) => r.status === 'proposed' && r.reviewedBy === null)).toBe(true);
    const principles = await h.kernel.call('principle:list', { projectId: project.id });
    expect(principles.every((p) => p.status === 'proposed')).toBe(true);

    const adopted = await h.kernel.call('route:review', { projectId: project.id, routeId: routes[0]!.id, action: 'adopt', actor: 'kel' });
    expect(adopted.status).toBe('adopted');
    expect(adopted.reviewedBy).toBe('kel');

    await expect(
      h.kernel.call('route:review', { projectId: project.id, routeId: routes[1]!.id, action: 'adopt', actor: '' }),
    ).rejects.toMatchObject({ code: 'invalid_params' });

    const rejected = await h.kernel.call('principle:review', { projectId: project.id, principleId: principles[0]!.id, action: 'reject', actor: 'kel' });
    expect(rejected.status).toBe('rejected');
    h.dispose();
  });

  it('P5：跨项目看不到分析产物', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'fixture', sourceType: 'local', localPath: fixtureRepo() });
    await indexLocalSource(h.kernel, project.id, project.localPath!);
    const other = await h.kernel.call('project:create', { name: 'other', sourceType: 'local' });

    expect(await h.kernel.call('route:list', { projectId: other.id })).toEqual([]);
    expect(await h.kernel.call('principle:list', { projectId: other.id })).toEqual([]);
    h.dispose();
  });

  it('目录不存在 → 明确报错；纯 JS 项目 → 0 文件但不失败', async () => {
    const h = testKernel();
    const project = await h.kernel.call('project:create', { name: 'x', sourceType: 'local' });
    await expect(indexLocalSource(h.kernel, project.id, '/nonexistent/path')).rejects.toMatchObject({ code: 'source_not_found' });

    // 空仓库：索引成功但无产物（诚实：无 TS 即无路由/原则，不伪造）
    const emptyDir = join(tmpdir(), `dat-empty-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(emptyDir, 'src'), { recursive: true });
    writeFileSync(join(emptyDir, 'src', 'plain.js'), 'module.exports = 1;');
    const scan = await indexLocalSource(h.kernel, project.id, emptyDir);
    expect(scan.fileCount).toBe(0);
    expect(scan.routesInserted).toBe(0);
    expect(scan.principlesInserted).toBe(0);
    h.dispose();
  });
});
