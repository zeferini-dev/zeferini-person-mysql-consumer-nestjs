import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, Connection, connect } from 'amqplib';
import mysql from 'mysql2/promise';

interface PersonMessage {
  id: string;
  name: string;
  email: string;
  createdAt?: string;
  updatedAt?: string;
}

@Injectable()
export class ConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsumerService.name);
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private mysqlPool: mysql.Pool;
  private readonly queue: string;

  constructor(private readonly config: ConfigService) {
    this.queue = this.config.get<string>('RABBITMQ_QUEUE', 'person_events');

    this.mysqlPool = mysql.createPool({
      uri: this.config.get<string>('MYSQL_URL', 'mysql://appuser:app123@mysql-app:3306/appdb'),
      waitForConnections: true,
      connectionLimit: 10,
    });
  }

  async onModuleInit() {
    await this.connectRabbit();
    await this.ensureQueue();
    await this.consume();
    this.logger.log(`Consuming queue '${this.queue}' and writing to MySQL.`);
  }

  async onModuleDestroy() {
    if (this.channel) {
      await this.channel.close().catch(() => undefined);
      this.channel = null;
    }
    if (this.connection) {
      await (this.connection as any)?.close?.().catch(() => undefined);
      this.connection = null;
    }
    await this.mysqlPool.end().catch(() => undefined);
  }

  private async connectRabbit() {
    const url = this.config.get<string>('RABBITMQ_URL', 'amqp://admin:admin123@rabbitmq:5672');
    const maxRetries = 10;
    let retries = 0;
    let lastError: Error | null = null;

    while (retries < maxRetries) {
      try {
        this.connection = (await connect(url)) as unknown as Connection;
        this.channel = await (this.connection as any).createChannel();
        this.logger.log(`Connected to RabbitMQ (${url.replace(/:[^:@]+@/, ':****@')})`);
        return;
      } catch (error) {
        lastError = error as Error;
        retries++;
        const delayMs = Math.min(1000 * Math.pow(2, retries - 1), 30000);
        this.logger.warn(
          `RabbitMQ connection failed (attempt ${retries}/${maxRetries}). Retrying in ${delayMs}ms...`,
          lastError.message,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(`Failed to connect to RabbitMQ after ${maxRetries} attempts: ${lastError?.message}`);
  }

  private async ensureQueue() {
    if (!this.channel) throw new Error('Channel not initialized');
    await this.channel.assertQueue(this.queue, { durable: true });
  }

  private parseMessage(msg: Buffer): PersonMessage {
    const obj = JSON.parse(msg.toString());
    const eventData = obj.eventData ?? obj; // support both wrapped and flat payloads

    return {
      id: eventData.id,
      name: eventData.name,
      email: eventData.email,
      createdAt: eventData.createdAt ?? obj.createdAt,
      updatedAt: eventData.updatedAt ?? obj.updatedAt,
    };
  }

  private async upsertPerson(data: PersonMessage) {
    if (!data.id || !data.name || !data.email) {
      throw new Error('Missing required person fields (id, name, email)');
    }

    const conn = await this.mysqlPool.getConnection();
    try {
      const sql = `
        INSERT INTO persons (id, name, email, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          email = VALUES(email),
          updatedAt = VALUES(updatedAt);
      `;
      const createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
      const updatedAt = data.updatedAt ? new Date(data.updatedAt) : new Date();
      await conn.execute(sql, [data.id, data.name, data.email, createdAt, updatedAt]);
    } finally {
      conn.release();
    }
  }

  private async consume() {
    if (!this.channel) throw new Error('Channel not initialized');

    this.channel.consume(this.queue, async (msg) => {
      if (!msg) return;
      try {
        const payload = this.parseMessage(msg.content);
        await this.upsertPerson(payload);
        this.channel!.ack(msg);
        this.logger.log(`Upserted person ${payload.id}`);
      } catch (err) {
        this.logger.error('Failed to process message', err as Error);
        this.channel!.nack(msg, false, false); // discard bad message
      }
    }, { noAck: false });
  }
}
