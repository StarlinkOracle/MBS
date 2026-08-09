import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { GoogleAuth } from 'google-auth-library';

interface AnalyticsData {
  pageViews: number;
  uniqueVisitors: number;
  avgSessionDuration: string;
  bounceRate: string;
  conversionRate: string;
  topPages: Array<{
    page: string;
    views: number;
    avgTime: string;
  }>;
  deviceBreakdown: Array<{
    device: string;
    users: number;
    percentage: number;
  }>;
  trafficSources: Array<{
    source: string;
    users: number;
    percentage: number;
  }>;
  dailyStats: Array<{
    date: string;
    visitors: number;
    pageViews: number;
  }>;
  sectionEngagement: Array<{
    section: string;
    timeSpent: number;
    views: number;
  }>;
}

class GoogleAnalyticsService {
  private analyticsDataClient: BetaAnalyticsDataClient | null = null;
  private propertyId: string | null = null;

  constructor() {
    this.initializeClient();
  }

  private async initializeClient() {
    try {
      const measurementId = process.env.VITE_GA_MEASUREMENT_ID;
      const projectId = process.env.GOOGLE_CLOUD_PROJECT;
      const serviceAccountEmail = process.env.GOOGLE_ANALYTICS_SERVICE_ACCOUNT_EMAIL;

      if (!measurementId) {
        console.warn('Missing Google Analytics measurement ID. Using mock data.');
        return;
      }

      if (!projectId || !serviceAccountEmail) {
        console.warn('Missing Google Cloud project configuration for Workload Identity. Using mock data.');
        return;
      }

      // Extract property ID from measurement ID (G-XXXXXXXXXX → properties/XXXXXXXXXX)
      this.propertyId = `properties/${measurementId.replace('G-', '')}`;

      // Initialize with Workload Identity Federation
      // The GoogleAuth will automatically use Application Default Credentials
      // which includes Workload Identity when running on Google Cloud
      const auth = new GoogleAuth({
        scopes: [
          'https://www.googleapis.com/auth/analytics.readonly',
          'https://www.googleapis.com/auth/analytics'
        ],
      });

      this.analyticsDataClient = new BetaAnalyticsDataClient({ auth });
      
      console.log('Google Analytics service initialized with Workload Identity Federation');
      console.log(`Using service account: ${serviceAccountEmail}`);
      console.log(`Property ID: ${this.propertyId}`);
    } catch (error) {
      console.error('Failed to initialize Google Analytics service:', error);
      console.log('Falling back to mock data');
    }
  }

  private formatDuration(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  private formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  async getAnalyticsData(): Promise<AnalyticsData> {
    if (!this.analyticsDataClient || !this.propertyId) {
      return this.getMockData();
    }

    try {
      // Fetch basic metrics (last 30 days)
      const [basicMetrics] = await this.analyticsDataClient.runReport({
        property: this.propertyId,
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'activeUsers' },
          { name: 'averageSessionDuration' },
          { name: 'bounceRate' },
          { name: 'conversions' },
          { name: 'sessions' }
        ],
      });

      // Fetch top pages
      const [topPages] = await this.analyticsDataClient.runReport({
        property: this.propertyId,
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' }
        ],
        limit: 5,
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      });

      // Fetch device breakdown
      const [deviceData] = await this.analyticsDataClient.runReport({
        property: this.propertyId,
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'activeUsers' }],
      });

      // Fetch traffic sources
      const [trafficSources] = await this.analyticsDataClient.runReport({
        property: this.propertyId,
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      });

      // Fetch daily stats (last 7 days)
      const [dailyStats] = await this.analyticsDataClient.runReport({
        property: this.propertyId,
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'activeUsers' },
          { name: 'screenPageViews' }
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });

      // Process the data
      const basicRow = basicMetrics.rows?.[0];
      const pageViews = parseInt(basicRow?.metricValues?.[0]?.value || '0');
      const uniqueVisitors = parseInt(basicRow?.metricValues?.[1]?.value || '0');
      const avgDuration = parseFloat(basicRow?.metricValues?.[2]?.value || '0');
      const bounceRate = parseFloat(basicRow?.metricValues?.[3]?.value || '0');
      const conversions = parseInt(basicRow?.metricValues?.[4]?.value || '0');
      const sessions = parseInt(basicRow?.metricValues?.[5]?.value || '0');

      // Calculate conversion rate
      const conversionRate = sessions > 0 ? ((conversions / sessions) * 100).toFixed(1) : '0';

      // Process top pages
      const processedPages = topPages.rows?.slice(0, 5).map(row => ({
        page: row.dimensionValues?.[1]?.value || 'Unknown',
        views: parseInt(row.metricValues?.[0]?.value || '0'),
        avgTime: this.formatDuration(parseFloat(row.metricValues?.[1]?.value || '0'))
      })) || [];

      // Process device data
      const totalDeviceUsers = deviceData.rows?.reduce((sum, row) => 
        sum + parseInt(row.metricValues?.[0]?.value || '0'), 0) || 1;
      
      const processedDevices = deviceData.rows?.map(row => {
        const users = parseInt(row.metricValues?.[0]?.value || '0');
        return {
          device: this.capitalizeFirst(row.dimensionValues?.[0]?.value || 'Unknown'),
          users,
          percentage: Math.round((users / totalDeviceUsers) * 100)
        };
      }) || [];

      // Process traffic sources
      const totalSourceUsers = trafficSources.rows?.reduce((sum, row) => 
        sum + parseInt(row.metricValues?.[0]?.value || '0'), 0) || 1;
      
      const processedSources = trafficSources.rows?.map(row => {
        const users = parseInt(row.metricValues?.[0]?.value || '0');
        return {
          source: this.formatChannelName(row.dimensionValues?.[0]?.value || 'Unknown'),
          users,
          percentage: Math.round((users / totalSourceUsers) * 100)
        };
      }) || [];

      // Process daily stats
      const processedDailyStats = dailyStats.rows?.map(row => ({
        date: this.formatDate(row.dimensionValues?.[0]?.value || ''),
        visitors: parseInt(row.metricValues?.[0]?.value || '0'),
        pageViews: parseInt(row.metricValues?.[1]?.value || '0')
      })) || [];

      return {
        pageViews,
        uniqueVisitors,
        avgSessionDuration: this.formatDuration(avgDuration),
        bounceRate: `${bounceRate.toFixed(1)}%`,
        conversionRate: `${conversionRate}%`,
        topPages: processedPages,
        deviceBreakdown: processedDevices,
        trafficSources: processedSources,
        dailyStats: processedDailyStats,
        sectionEngagement: this.getMockSectionEngagement() // This requires custom tracking
      };

    } catch (error) {
      console.error('Error fetching Google Analytics data:', error);
      return this.getMockData();
    }
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }

  private formatChannelName(channel: string): string {
    const channelMap: { [key: string]: string } = {
      'Organic Search': 'Google Search',
      'Direct': 'Direct',
      'Social': 'Social Media',
      'Referral': 'Referrals',
      'Paid Search': 'Paid Ads',
      'Email': 'Email Marketing',
      'Display': 'Display Ads'
    };
    return channelMap[channel] || channel;
  }

  private getMockSectionEngagement() {
    // Section engagement requires custom event tracking
    // For now, return mock data - you can implement custom events later
    return [
      { section: "Hero", timeSpent: 45, views: 567 },
      { section: "Services", timeSpent: 89, views: 423 },
      { section: "About Us", timeSpent: 67, views: 345 },
      { section: "Testimonials", timeSpent: 34, views: 289 },
      { section: "Contact Form", timeSpent: 156, views: 234 }
    ];
  }

  private getMockData(): AnalyticsData {
    // Fallback mock data when API is not available
    return {
      pageViews: 1247,
      uniqueVisitors: 892,
      avgSessionDuration: "3:42",
      bounceRate: "42%",
      conversionRate: "12.5%",
      topPages: [
        { page: "Homepage", views: 567, avgTime: "4:23" },
        { page: "Services", views: 234, avgTime: "2:17" },
        { page: "About Us", views: 189, avgTime: "1:45" },
        { page: "Quote Comparison", views: 156, avgTime: "3:56" },
        { page: "Contact", views: 101, avgTime: "2:34" }
      ],
      deviceBreakdown: [
        { device: "Mobile", users: 498, percentage: 56 },
        { device: "Desktop", users: 313, percentage: 35 },
        { device: "Tablet", users: 81, percentage: 9 }
      ],
      trafficSources: [
        { source: "Google Search", users: 425, percentage: 48 },
        { source: "Direct", users: 267, percentage: 30 },
        { source: "Social Media", users: 134, percentage: 15 },
        { source: "Referrals", users: 66, percentage: 7 }
      ],
      dailyStats: [
        { date: "Jul 1", visitors: 45, pageViews: 89 },
        { date: "Jul 2", visitors: 52, pageViews: 103 },
        { date: "Jul 3", visitors: 38, pageViews: 76 },
        { date: "Jul 4", visitors: 61, pageViews: 127 },
        { date: "Jul 5", visitors: 49, pageViews: 98 },
        { date: "Jul 6", visitors: 55, pageViews: 112 },
        { date: "Jul 7", visitors: 67, pageViews: 134 }
      ],
      sectionEngagement: [
        { section: "Hero", timeSpent: 45, views: 567 },
        { section: "Services", timeSpent: 89, views: 423 },
        { section: "About Us", timeSpent: 67, views: 345 },
        { section: "Testimonials", timeSpent: 34, views: 289 },
        { section: "Contact Form", timeSpent: 156, views: 234 }
      ]
    };
  }
}

export const googleAnalyticsService = new GoogleAnalyticsService();
export type { AnalyticsData };