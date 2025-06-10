import { Module, NestModule, MiddlewareConsumer, Logger } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthMiddleware } from './auth.middleware';
import { ConfigModule } from '@nestjs/config';
import { JellyfinAuthService } from './jellyfin-auth.service';
import { ScheduleModule } from '@nestjs/schedule';
import { CleanupService } from './cleanup/cleanup.service';
import { FileRemoval } from './cleanup/removalUtils';
import { CacheService } from './cache/cache.service';
import { QualityService } from './cache/quality.service';
import { JobMappingService } from './cache/job-mapping.service';


@Module({
  imports: [ScheduleModule.forRoot(), ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController],
  providers: [
    AppService,
    Logger,
    JellyfinAuthService,
    FileRemoval, // Still used by AppService for legacy cleanup
    CacheService,
    QualityService,
    JobMappingService,
    CleanupService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        'optimize-version',
        'download/:id',
        'cancel-job/:id',
        'statistics',
        'job-status/:id',
        'start-job/:id',
        'all-jobs',
        'delete-cache',
        // Dashboard routes are public for easy monitoring
      );
  }
}
