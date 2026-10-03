import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountsController, AccountsService } from './accounts/accounts';
import { AddressesController, AddressesService } from './addresses/addresses';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { MailService } from './auth/mail.service';
import { PasswordService } from './auth/password.service';
import { TokenService } from './auth/tokens';
import { CacheStatsController } from './cache/cache-stats.controller';
import { CacheService } from './cache/cache.service';
import { CouponRedemptionService } from './cache/coupon-redemption.service';
import { HttpCacheInterceptor } from './cache/http-cache.interceptor';
import { RateLimitGuard } from './cache/rate-limit.guard';
import { RedisService } from './cache/redis.service';
import { AdminCatalogController } from './catalog/admin-catalog.controller';
import { AdminCatalogService } from './catalog/admin-catalog.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { MongoService } from './catalog/mongo.service';
import { SearchController } from './catalog/search.controller';
import { SearchService } from './catalog/search.service';
import { ApiErrorFilter } from './common/api-error.filter';
import { AuthGuard, CsrfGuard, OptionalAuthGuard } from './common/auth';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { AdminOrderController } from './commerce/admin-order.controller';
import { AdminOrderService } from './commerce/admin-order.service';
import { CartController } from './commerce/cart.controller';
import { CartService } from './commerce/cart.service';
import { CheckoutController } from './commerce/checkout.controller';
import { InventoryService } from './commerce/inventory.service';
import { OrderController, OrderStreamOwnershipGuard } from './commerce/order.controller';
import { OrderService } from './commerce/order.service';
import { PaymentController } from './commerce/payment.controller';
import { PaymentService } from './commerce/payment.service';
import { RazorpayService } from './commerce/razorpay.service';
import { API_CONFIG, type ApiConfig } from './config';
import { DevOutboxController, HealthController } from './health/health';
import { DeadLetterController } from './messaging/dead-letter.controller';
import { NotificationConsumerService } from './messaging/notification-consumer.service';
import { OrderEventsService } from './messaging/order-events.service';
import { OutboxRelayService } from './messaging/outbox-relay.service';
import { OutboxService } from './messaging/outbox.service';
import { RabbitService } from './messaging/rabbit.service';
import { SchedulerService } from './messaging/scheduler.service';
import { MetricsController } from './metrics/metrics.controller';
import { MetricsMiddleware } from './metrics/metrics.middleware';
import { MetricsService } from './metrics/metrics.service';
import { PrismaService } from './prisma/prisma.service';

/**
 * Modular monolith root (BF-01). Domains (auth, accounts, addresses, catalog, commerce ...) are
 * separate folders that talk through services, so any of them can be extracted into its own service later.
 */
@Module({})
export class AppModule implements NestModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Global default for every route; auth endpoints set a stricter limit of their own (BF-09).
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: config.rateLimits.global.limit }], skipIf: () => !config.rateLimit }),
      ],
      controllers: [
        HealthController,
        DevOutboxController,
        AuthController,
        AccountsController,
        AddressesController,
        CatalogController,
        SearchController,
        AdminCatalogController,
        CartController,
        CheckoutController,
        OrderController,
        PaymentController,
        AdminOrderController,
        CacheStatsController,
        DeadLetterController,
        MetricsController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ApiErrorFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor },
        RedisService,
        CacheService,
        CouponRedemptionService,
        PrismaService,
        PasswordService,
        TokenService,
        MailService,
        AuthService,
        AccountsService,
        AddressesService,
        AuthGuard,
        CsrfGuard,
        OptionalAuthGuard,
        MongoService,
        SearchService,
        CatalogService,
        AdminCatalogService,
        CartService,
        InventoryService,
        OrderService,
        OrderStreamOwnershipGuard,
        RazorpayService,
        PaymentService,
        AdminOrderService,
        RabbitService,
        OutboxService,
        OutboxRelayService,
        NotificationConsumerService,
        SchedulerService,
        OrderEventsService,
        MetricsService,
        MetricsMiddleware,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
    consumer.apply(MetricsMiddleware).forRoutes('{*splat}');
  }
}
