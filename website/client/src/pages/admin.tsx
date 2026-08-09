import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { QuoteComparison, ContactRequest } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { Eye, Mail, Phone, DollarSign, Building, FileText, Calendar, BarChart, Lock } from "lucide-react";
import AnalyticsDashboard from "@/components/analytics-dashboard";

// Login component - separate to avoid hooks issues
function LoginForm({ onLogin }: { onLogin: (success: boolean) => void }) {
  const [credentials, setCredentials] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (credentials.username === "admin" && credentials.password === "russell2024") {
      localStorage.setItem("admin-auth", "true");
      onLogin(true);
    } else {
      setLoginError("Invalid username or password");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Lock className="h-12 w-12 text-blue-600 mx-auto mb-4" />
          <CardTitle className="text-2xl">Admin Login</CardTitle>
          <p className="text-gray-600">Russell Comfort Solutions</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                type="text"
                value={credentials.username}
                onChange={(e) => setCredentials({...credentials, username: e.target.value})}
                required
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={credentials.password}
                onChange={(e) => setCredentials({...credentials, password: e.target.value})}
                required
              />
            </div>
            {loginError && (
              <p className="text-red-600 text-sm">{loginError}</p>
            )}
            <Button type="submit" className="w-full">
              Login
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminPage() {
  const [selectedTab, setSelectedTab] = useState("analytics");
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check if user is already logged in on component mount
  useEffect(() => {
    const isLoggedIn = localStorage.getItem("admin-auth") === "true";
    setIsAuthenticated(isLoggedIn);
  }, []);

  const handleLogin = (success: boolean) => {
    setIsAuthenticated(success);
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem("admin-auth");
  };

  // Fetch quote comparisons - always called, same hook order
  const { data: quotes = [], isLoading: quotesLoading } = useQuery<QuoteComparison[]>({
    queryKey: ["/api/admin/quotes"],
    enabled: isAuthenticated, // Only fetch when authenticated
  });

  // Fetch contact requests - always called, same hook order
  const { data: contacts = [], isLoading: contactsLoading } = useQuery<ContactRequest[]>({
    queryKey: ["/api/admin/contacts"],
    enabled: isAuthenticated, // Only fetch when authenticated
  });

  // Update quote status mutation
  const updateQuoteMutation = useMutation({
    mutationFn: async ({ id, status, ourQuoteAmount }: { 
      id: number; 
      status: string; 
      ourQuoteAmount?: string;
    }) => {
      const response = await fetch(`/api/admin/quotes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ourQuoteAmount, isReviewed: true }),
      });
      if (!response.ok) throw new Error("Failed to update quote");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/quotes"] });
    },
  });

  // Mark contact as read mutation
  const markContactReadMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await fetch(`/api/admin/contacts/${id}/read`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error("Failed to mark contact as read");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts"] });
    },
  });

  const getStatusBadge = (status: string) => {
    const colors = {
      pending: "bg-yellow-100 text-yellow-800",
      matched: "bg-blue-100 text-blue-800", 
      beat: "bg-green-100 text-green-800",
      declined: "bg-red-100 text-red-800"
    };
    return (
      <Badge className={colors[status as keyof typeof colors] || colors.pending}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  const QuoteCard = ({ quote }: { quote: QuoteComparison }) => {
    const [ourQuote, setOurQuote] = useState(quote.ourQuoteAmount || "");
    const [status, setStatus] = useState(quote.status);

    const handleUpdate = () => {
      updateQuoteMutation.mutate({
        id: quote.id,
        status,
        ourQuoteAmount: ourQuote
      });
    };

    return (
      <Card className="mb-4">
        <CardHeader>
          <div className="flex justify-between items-start">
            <CardTitle className="text-lg">
              {quote.firstName} {quote.lastName}
            </CardTitle>
            <div className="flex gap-2">
              {getStatusBadge(quote.status)}
              {!quote.isReviewed && (
                <Badge variant="outline" className="bg-orange-50 text-orange-600">
                  New
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-gray-500" />
                <span className="text-sm">{quote.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-gray-500" />
                <span className="text-sm">{quote.phone}</span>
              </div>
              <div className="flex items-center gap-2">
                <Building className="w-4 h-4 text-gray-500" />
                <span className="text-sm">{quote.serviceType}</span>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Building className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium">Competitor: {quote.competitorName}</span>
              </div>
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium">Their Quote: ${quote.quoteAmount}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-500" />
                <span className="text-sm">{formatDistanceToNow(new Date(quote.createdAt))} ago</span>
              </div>
            </div>
          </div>

          {quote.quoteFileUrl && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-blue-500" />
                <span className="text-sm font-medium">Uploaded Quote File:</span>
              </div>
              <div className="bg-blue-50 p-3 rounded border border-blue-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-blue-800 font-medium">{quote.quoteFileUrl.split('_').pop() || 'Quote File'}</p>
                    <p className="text-xs text-blue-600">Customer uploaded competitor quote</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      window.open(`/api/admin/quotes/${quote.id}/file`, '_blank');
                    }}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    <FileText className="w-4 h-4 mr-1" />
                    View File
                  </Button>
                </div>
              </div>
            </div>
          )}

          {quote.description && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium">Description:</span>
              </div>
              <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded">{quote.description}</p>
            </div>
          )}

          {/* Admin Actions */}
          <div className="border-t pt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label htmlFor={`quote-${quote.id}`}>Our Quote Amount</Label>
                <Input
                  id={`quote-${quote.id}`}
                  value={ourQuote}
                  onChange={(e) => setOurQuote(e.target.value)}
                  placeholder="Enter amount"
                />
              </div>
              <div>
                <Label htmlFor={`status-${quote.id}`}>Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="matched">Price Matched</SelectItem>
                    <SelectItem value="beat">We Beat Their Price</SelectItem>
                    <SelectItem value="declined">Declined</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button 
                  onClick={handleUpdate}
                  disabled={updateQuoteMutation.isPending}
                  className="w-full"
                >
                  {updateQuoteMutation.isPending ? "Updating..." : "Update"}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const ContactCard = ({ contact }: { contact: ContactRequest }) => {
    const handleMarkRead = () => {
      markContactReadMutation.mutate(contact.id);
    };

    return (
      <Card className="mb-4">
        <CardHeader>
          <div className="flex justify-between items-start">
            <CardTitle className="text-lg">
              {contact.firstName} {contact.lastName}
            </CardTitle>
            <div className="flex gap-2">
              {!contact.isRead && (
                <Badge variant="outline" className="bg-orange-50 text-orange-600">
                  Unread
                </Badge>
              )}
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleMarkRead}
                disabled={contact.isRead || markContactReadMutation.isPending}
              >
                <Eye className="w-4 h-4 mr-1" />
                {contact.isRead ? "Read" : "Mark Read"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-gray-500" />
                <span className="text-sm">{contact.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-gray-500" />
                <span className="text-sm">{contact.phone}</span>
              </div>
            </div>
            <div className="space-y-2">
              {contact.serviceType && (
                <div className="flex items-center gap-2">
                  <Building className="w-4 h-4 text-gray-500" />
                  <span className="text-sm">{contact.serviceType}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-500" />
                <span className="text-sm">{formatDistanceToNow(new Date(contact.createdAt))} ago</span>
              </div>
            </div>
          </div>

          {contact.message && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium">Message:</span>
              </div>
              <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded">{contact.message}</p>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  // Show login form if not authenticated
  if (!isAuthenticated) {
    return <LoginForm onLogin={handleLogin} />;
  }

  if (quotesLoading || contactsLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-accent mx-auto mb-4"></div>
          <p>Loading admin panel...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Russell Comfort Solutions - Admin Panel</h1>
            <p className="text-gray-600">Manage quote comparisons and contact requests</p>
          </div>
          <Button
            onClick={handleLogout}
            variant="outline"
            className="flex items-center gap-2"
          >
            <Lock className="w-4 h-4" />
            Logout
          </Button>
        </div>

        <Tabs value={selectedTab} onValueChange={setSelectedTab}>
          <TabsList className="grid w-full grid-cols-3 max-w-lg">
            <TabsTrigger value="analytics">
              <BarChart className="w-4 h-4 mr-2" />
              Analytics
            </TabsTrigger>
            <TabsTrigger value="quotes">
              Quote Matches ({quotes.filter((q: QuoteComparison) => !q.isReviewed).length} new)
            </TabsTrigger>
            <TabsTrigger value="contacts">
              Contact Requests ({contacts.filter((c: ContactRequest) => !c.isRead).length} unread)
            </TabsTrigger>
          </TabsList>

          <TabsContent value="analytics" className="mt-6">
            <AnalyticsDashboard />
          </TabsContent>

          <TabsContent value="quotes" className="mt-6">
            <div className="mb-4">
              <h2 className="text-xl font-semibold mb-2">Quote Match Requests</h2>
              <p className="text-gray-600">Review competitor quotes and respond with your pricing</p>
            </div>
            
            {quotes.length === 0 ? (
              <Card>
                <CardContent className="text-center py-8">
                  <p className="text-gray-500">No quote match requests yet.</p>
                </CardContent>
              </Card>
            ) : (
              <div>
                {quotes.map((quote: QuoteComparison) => (
                  <QuoteCard key={quote.id} quote={quote} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="contacts" className="mt-6">
            <div className="mb-4">
              <h2 className="text-xl font-semibold mb-2">Contact Requests</h2>
              <p className="text-gray-600">Review and respond to customer inquiries</p>
            </div>
            
            {contacts.length === 0 ? (
              <Card>
                <CardContent className="text-center py-8">
                  <p className="text-gray-500">No contact requests yet.</p>
                </CardContent>
              </Card>
            ) : (
              <div>
                {contacts.map((contact: ContactRequest) => (
                  <ContactCard key={contact.id} contact={contact} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}