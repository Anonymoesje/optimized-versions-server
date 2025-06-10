import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import { AppService, Job } from './app.service';
import { log } from 'console';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private logger: Logger,
  ) {}

  @Get('statistics')
  async getStatistics() {
    return this.appService.getStatistics();
  }

  @Get('dashboard')
  getDashboard(@Res() res: Response) {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Optimized Versions Server - Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            color: white;
            margin-bottom: 30px;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .card {
            background: white;
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s;
        }

        .card:hover {
            transform: translateY(-2px);
        }

        .card h3 {
            color: #333;
            margin-bottom: 16px;
            font-size: 1.2rem;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .stat-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }

        .stat-item:last-child {
            border-bottom: none;
        }

        .stat-label {
            color: #666;
        }

        .stat-value {
            font-weight: 600;
            color: #333;
        }

        .jobs-card {
            grid-column: 1 / -1;
        }

        .job-item, .cache-item {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
            border-left: 4px solid #667eea;
        }

        .job-header, .cache-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .job-title, .cache-title {
            font-weight: 600;
            color: #333;
        }

        .cache-title-section {
            flex: 1;
        }

        .cache-meta {
            display: flex;
            gap: 12px;
            margin-top: 4px;
            font-size: 0.85rem;
            color: #666;
        }

        .cache-type, .cache-quality, .cache-time {
            background: #e9ecef;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.8rem;
        }

        .cache-status-section {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 4px;
        }

        .cache-size {
            font-size: 0.85rem;
            color: #666;
            font-weight: 500;
        }

        .job-status {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 500;
        }

        .status-queued { background: #fff3cd; color: #856404; }
        .status-optimizing { background: #d4edda; color: #155724; }
        .status-completed { background: #d1ecf1; color: #0c5460; }
        .status-failed { background: #f8d7da; color: #721c24; }

        .progress-bar {
            width: 100%;
            height: 8px;
            background: #e9ecef;
            border-radius: 4px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #667eea, #764ba2);
            transition: width 0.3s ease;
        }

        .loading {
            text-align: center;
            color: #666;
            padding: 20px;
        }

        .refresh-info {
            text-align: center;
            color: white;
            opacity: 0.8;
            margin-top: 20px;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 2rem;
            }

            .grid {
                grid-template-columns: 1fr;
            }

            .job-header, .cache-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 8px;
            }

            .cache-status-section {
                align-items: flex-start;
            }

            .cache-meta {
                flex-wrap: wrap;
                gap: 8px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎬 Optimized Versions Server</h1>
            <p>Real-time Dashboard & Monitoring</p>
        </div>

        <div id="dashboard-content">
            <div class="loading">
                <p>Loading dashboard data...</p>
            </div>
        </div>

        <div class="refresh-info">
            <p>📡 Auto-refreshing every 5 seconds</p>
        </div>
    </div>

    <script>
        let refreshInterval;

        async function loadDashboardData() {
            try {
                const response = await fetch('/dashboard/stats');
                const data = await response.json();
                renderDashboard(data);
            } catch (error) {
                console.error('Failed to load dashboard data:', error);
                document.getElementById('dashboard-content').innerHTML =
                    '<div class="loading"><p>❌ Failed to load data. Retrying...</p></div>';
            }
        }

        function renderDashboard(data) {
            const content = \`
                <div class="grid">
                    <div class="card">
                        <h3>📊 System Stats</h3>
                        <div class="stat-item">
                            <span class="stat-label">Uptime</span>
                            <span class="stat-value">\${data.system.uptime}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Active Jobs</span>
                            <span class="stat-value">\${data.system.activeJobs}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Queue Length</span>
                            <span class="stat-value">\${data.system.queueLength}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Max Concurrent</span>
                            <span class="stat-value">\${data.system.maxConcurrent}</span>
                        </div>
                    </div>

                    <div class="card">
                        <h3>🎬 Cache Overview</h3>
                        <div class="stat-item">
                            <span class="stat-label">Total Items</span>
                            <span class="stat-value">\${data.cache.totalItems}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Total Size</span>
                            <span class="stat-value">\${data.cache.totalSize}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Oldest Item</span>
                            <span class="stat-value">\${data.cache.oldestItem}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Ready for Cleanup</span>
                            <span class="stat-value">\${data.cache.readyForCleanup}</span>
                        </div>
                    </div>

                    <div class="card">
                        <h3>📈 Statistics</h3>
                        <div class="stat-item">
                            <span class="stat-label">Total Transcodes</span>
                            <span class="stat-value">\${data.stats.totalTranscodes}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Completed Jobs</span>
                            <span class="stat-value">\${data.stats.completedJobs}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Failed Jobs</span>
                            <span class="stat-value">\${data.stats.failedJobs}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Unique Devices</span>
                            <span class="stat-value">\${data.stats.uniqueDevices}</span>
                        </div>
                    </div>

                    <div class="card">
                        <h3>🧹 Cleanup Status</h3>
                        <div class="stat-item">
                            <span class="stat-label">Retention Period</span>
                            <span class="stat-value">\${data.cleanup.retentionHours}h</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Last Cleanup</span>
                            <span class="stat-value">\${data.cleanup.lastCleanup}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Next Cleanup</span>
                            <span class="stat-value">\${data.cleanup.nextCleanup}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Items Cleaned Today</span>
                            <span class="stat-value">\${data.cleanup.itemsCleanedToday}</span>
                        </div>
                    </div>
                </div>

                <div class="card jobs-card">
                    <h3>🔄 Current Jobs</h3>
                    \${data.jobs.length === 0 ?
                        '<p style="text-align: center; color: #666; padding: 20px;">No active jobs</p>' :
                        data.jobs.map(job => \`
                            <div class="job-item">
                                <div class="job-header">
                                    <span class="job-title">\${job.title}</span>
                                    <span class="job-status status-\${job.status}">\${job.statusText}</span>
                                </div>
                                \${job.status === 'optimizing' ? \`
                                    <div class="progress-bar">
                                        <div class="progress-fill" style="width: \${job.progress}%"></div>
                                    </div>
                                    <div style="margin-top: 8px; font-size: 0.9rem; color: #666;">
                                        \${job.progress}% • \${job.speed}x speed
                                    </div>
                                \` : ''}
                            </div>
                        \`).join('')
                    }
                </div>

                <div class="card jobs-card">
                    <h3>🎬 Cached Shows & Movies</h3>
                    \${data.cachedItems.length === 0 ?
                        '<p style="text-align: center; color: #666; padding: 20px;">No cached items</p>' :
                        data.cachedItems.map(item => \`
                            <div class="cache-item">
                                <div class="cache-header">
                                    <div class="cache-title-section">
                                        <span class="cache-title">\${item.title}</span>
                                        <div class="cache-meta">
                                            <span class="cache-type">\${item.type}</span>
                                            <span class="cache-quality">\${item.quality}</span>
                                            <span class="cache-time">\${item.timeAgo}</span>
                                        </div>
                                    </div>
                                    <div class="cache-status-section">
                                        <span class="job-status status-\${item.status}">\${item.statusText}</span>
                                        \${item.status === 'completed' ? \`<span class="cache-size">\${item.size}</span>\` : ''}
                                    </div>
                                </div>
                                \${item.status === 'processing' ? \`
                                    <div class="progress-bar">
                                        <div class="progress-fill" style="width: \${item.progress}%"></div>
                                    </div>
                                    <div style="margin-top: 8px; font-size: 0.9rem; color: #666;">
                                        \${item.progress}% complete
                                    </div>
                                \` : ''}
                                \${item.status === 'failed' && item.error ? \`
                                    <div style="margin-top: 8px; font-size: 0.9rem; color: #dc3545;">
                                        Error: \${item.error}
                                    </div>
                                \` : ''}
                            </div>
                        \`).join('')
                    }
                </div>
            \`;

            document.getElementById('dashboard-content').innerHTML = content;
        }

        // Initial load
        loadDashboardData();

        // Auto-refresh every 5 seconds
        refreshInterval = setInterval(loadDashboardData, 5000);

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            if (refreshInterval) {
                clearInterval(refreshInterval);
            }
        });
    </script>
</body>
</html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }

  @Get('dashboard/stats')
  async getDashboardStats() {
    return this.appService.getDashboardStats();
  }

  @Post('optimize-version')
  async downloadAndCombine(
    @Body('url') url: string,
    @Body('fileExtension') fileExtension: string,
    @Body('deviceId') deviceId: string,
    @Body('itemId') itemId: string,
    @Body('item') item: any,
  ): Promise<{ id: string }> {
    this.logger.log(`Optimize request for URL: ${url.slice(0, 50)}...`);

    let jellyfinUrl = process.env.JELLYFIN_URL;

    let finalUrl: string;

    if (jellyfinUrl) {
      jellyfinUrl = jellyfinUrl.replace(/\/$/, '');
      // If JELLYFIN_URL is set, use it to replace the base of the incoming URL
      const parsedUrl = new URL(url);
      finalUrl = new URL(
        parsedUrl.pathname + parsedUrl.search,
        jellyfinUrl,
      ).toString();
    } else {
      // If JELLYFIN_URL is not set, use the incoming URL as is
      finalUrl = url;
    }

    const id = await this.appService.downloadAndCombine(
      finalUrl,
      fileExtension,
      deviceId,
      itemId,
      item,
    );
    return { id };
  }

  @Get('job-status/:id')
  async getActiveJob(@Param('id') id: string): Promise<Job | null> {
    return this.appService.getJobStatus(id);
  }

  @Post('start-job/:id')
  async startJob(@Param('id') id: string): Promise<{ message: string }> {
    this.logger.log(`Manual start request for job: ${id}`);

    try {
      const result = await this.appService.manuallyStartJob(id);
      if (result) {
        return { message: 'Job started successfully' };
      } else {
        throw new HttpException(
          'Job not found or already started',
          HttpStatus.BAD_REQUEST,
        );
      }
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Delete('cancel-job/:id')
  async cancelJob(@Param('id') id: string) {
    this.logger.log(`Cancellation request for job: ${id}`);
    const result = await this.appService.cancelJob(id);
    if (result) {
      return { message: 'Job cancelled successfully' };
    } else {
      return { message: 'Job not found or already completed' };
    }
  }

  @Get('all-jobs')
  async getAllJobs(@Query('deviceId') deviceId?: string) {
    return this.appService.getAllJobs(deviceId);
  }

  @Get('download/:id')
  async downloadTranscodedFile(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const filePath = await this.appService.getTranscodedFilePath(id);

    if (!filePath) {
      throw new NotFoundException('File not found or job not completed');
    }

    const stat = fs.statSync(filePath);

    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=transcoded_${id}.mp4`,
    );

    const fileStream = fs.createReadStream(filePath);
    this.logger.log(`Download started for ${filePath}`)

    return new Promise((resolve, reject) => {
      fileStream.pipe(res);

      fileStream.on('end', () => {
        // File transfer completed
        this.logger.log(`File transfer ended for: ${filePath}`)
        
        resolve(null);
      });

      fileStream.on('error', (err) => {
        // Handle errors during file streaming
        this.logger.error(`Error streaming file ${filePath}: ${err.message}`);
        reject(err);
      });
    });
  }


  @Delete('delete-cache')
  async deleteCache() {
    this.logger.log('Cache deletion request');
    return this.appService.deleteCache();
  }
}
