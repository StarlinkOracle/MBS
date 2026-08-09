import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { 
  Users, 
  Eye, 
  Clock, 
  Phone, 
  Calendar as CalendarIcon, 
  TrendingUp,
  Globe,
  Smartphone,
  Monitor,
  Loader2
} from "lucide-react";

// Sample analytics data structure - in production, this would come from Google Analytics API
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

// Mock data - replace with real Google Analytics data
const mockAnalyticsData: AnalyticsData = {
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

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8'];

export default function AnalyticsDashboard() {
  // Fetch real analytics data from the API
  const { data, isLoading, error } = useQuery<AnalyticsData>({
    queryKey: ['/api/admin/analytics'],
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
  });

  // Fallback to mock data if there's an error or no data
  const analyticsData = data || mockAnalyticsData;

  const MetricCard = ({ title, value, icon: Icon, change, changeType }: {
    title: string;
    value: string | number;
    icon: any;
    change?: string;
    changeType?: 'positive' | 'negative' | 'neutral';
  }) => (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-600">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
            {change && (
              <p className={`text-xs ${
                changeType === 'positive' ? 'text-green-600' : 
                changeType === 'negative' ? 'text-red-600' : 'text-gray-600'
              }`}>
                {change}
              </p>
            )}
          </div>
          <Icon className="h-8 w-8 text-gray-400" />
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Website Analytics</h2>
        <div className="flex items-center gap-2">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          <Badge variant="outline" className={isLoading ? "bg-yellow-50 text-yellow-600" : "bg-green-50 text-green-600"}>
            {isLoading ? "Loading..." : error ? "Using Sample Data" : "Live Data"}
          </Badge>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard
          title="Page Views"
          value={analyticsData.pageViews.toLocaleString()}
          icon={Eye}
          change="+12% from last week"
          changeType="positive"
        />
        <MetricCard
          title="Unique Visitors"
          value={analyticsData.uniqueVisitors.toLocaleString()}
          icon={Users}
          change="+8% from last week"
          changeType="positive"
        />
        <MetricCard
          title="Avg. Session Duration"
          value={analyticsData.avgSessionDuration}
          icon={Clock}
          change="+15% from last week"
          changeType="positive"
        />
        <MetricCard
          title="Conversion Rate"
          value={analyticsData.conversionRate}
          icon={TrendingUp}
          change="+3% from last week"
          changeType="positive"
        />
        <MetricCard
          title="Bounce Rate"
          value={analyticsData.bounceRate}
          icon={Globe}
          change="-5% from last week"
          changeType="positive"
        />
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="engagement">Section Engagement</TabsTrigger>
          <TabsTrigger value="traffic">Traffic Sources</TabsTrigger>
          <TabsTrigger value="devices">Device Breakdown</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Daily Traffic Chart */}
            <Card>
              <CardHeader>
                <CardTitle>Daily Traffic (Last 7 Days)</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={analyticsData.dailyStats}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Line type="monotone" dataKey="visitors" stroke="#8884d8" strokeWidth={2} />
                    <Line type="monotone" dataKey="pageViews" stroke="#82ca9d" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Top Pages */}
            <Card>
              <CardHeader>
                <CardTitle>Top Pages</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {analyticsData.topPages.map((page, index) => (
                    <div key={page.page} className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{page.page}</p>
                        <p className="text-sm text-gray-600">{page.views} views</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-medium">{page.avgTime}</p>
                        <p className="text-xs text-gray-600">avg. time</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="engagement" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Section Engagement</CardTitle>
              <p className="text-sm text-gray-600">Time spent and views per website section</p>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={analyticsData.sectionEngagement}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="section" />
                  <YAxis />
                  <Tooltip 
                    formatter={(value, name) => [
                      name === 'timeSpent' ? `${value}s` : value,
                      name === 'timeSpent' ? 'Avg. Time Spent' : 'Total Views'
                    ]}
                  />
                  <Bar dataKey="timeSpent" fill="#8884d8" name="timeSpent" />
                  <Bar dataKey="views" fill="#82ca9d" name="views" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="traffic" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Traffic Sources</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={analyticsData.trafficSources}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ source, percentage }) => `${source}: ${percentage}%`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="users"
                    >
                      {analyticsData.trafficSources.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                
                <div className="space-y-4">
                  {analyticsData.trafficSources.map((source, index) => (
                    <div key={source.source} className="flex items-center justify-between">
                      <div className="flex items-center">
                        <div 
                          className="w-4 h-4 rounded mr-3"
                          style={{ backgroundColor: COLORS[index % COLORS.length] }}
                        />
                        <span className="font-medium">{source.source}</span>
                      </div>
                      <div className="text-right">
                        <p className="font-medium">{source.users}</p>
                        <p className="text-sm text-gray-600">{source.percentage}%</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="devices" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Device Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {analyticsData.deviceBreakdown.map((device) => (
                  <Card key={device.device}>
                    <CardContent className="p-6 text-center">
                      <div className="flex justify-center mb-4">
                        {device.device === 'Mobile' && <Smartphone className="h-8 w-8 text-blue-500" />}
                        {device.device === 'Desktop' && <Monitor className="h-8 w-8 text-green-500" />}
                        {device.device === 'Tablet' && <Globe className="h-8 w-8 text-orange-500" />}
                      </div>
                      <h3 className="font-semibold text-lg">{device.device}</h3>
                      <p className="text-2xl font-bold text-gray-900">{device.users}</p>
                      <p className="text-sm text-gray-600">{device.percentage}% of total</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}