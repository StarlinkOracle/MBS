import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { trackSectionView, trackFormStart, trackFormSubmit, trackQuoteRequest } from "@/lib/analytics";
import { getAttributionSnapshot, fireConversionEvent } from "@/lib/attribution";
import { FileText, DollarSign, Target, Upload, X, Loader2 } from "lucide-react";
import { useLocation } from "wouter";

interface QuoteComparisonData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  serviceType: string;
  competitorName: string;
  quoteAmount: string;
  description: string;
}

export default function QuoteComparison() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [formData, setFormData] = useState<QuoteComparisonData>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "CO",
    zip: "",
    serviceType: "",
    competitorName: "",
    quoteAmount: "",
    description: "",
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [formStarted, setFormStarted] = useState(false);

  useEffect(() => {
    trackSectionView('quote_comparison');
  }, []);

  const quoteMutation = useMutation({
    mutationFn: async (data: QuoteComparisonData & { quoteFile?: File }) => {
      const attribution = getAttributionSnapshot();
      const fd = new FormData();
      
      Object.entries(data).forEach(([key, value]) => {
        if (key !== 'quoteFile' && value) {
          fd.append(key, value);
        }
      });

      fd.append('utmSource', attribution.utmSource || '');
      fd.append('utmMedium', attribution.utmMedium || '');
      fd.append('utmCampaign', attribution.utmCampaign || '');
      fd.append('utmContent', attribution.utmContent || '');
      fd.append('utmTerm', attribution.utmTerm || '');
      fd.append('gclid', attribution.gclid || '');
      fd.append('gbraid', attribution.gbraid || '');
      fd.append('wbraid', attribution.wbraid || '');
      fd.append('fbclid', attribution.fbclid || '');
      fd.append('landingUrl', attribution.landingUrl || '');
      fd.append('referrerUrl', attribution.referrerUrl || '');
      fd.append('visitorId', attribution.visitorId || '');
      
      if (data.quoteFile) {
        fd.append('quoteFile', data.quoteFile);
      }

      const response = await fetch("/api/quote-comparison", {
        method: "POST",
        body: fd,
      });
      
      if (!response.ok) {
        throw new Error("Failed to submit quote comparison");
      }
      
      return response.json();
    },
    onSuccess: (data) => {
      trackFormSubmit('quote_comparison');
      trackQuoteRequest('price_match');
      if (data.id) {
        fireConversionEvent(data.id);
      }
      navigate("/thank-you");
    },
    onError: (error: any) => {
      toast({
        title: "Something went wrong",
        description: error.message || "Please try again or call us directly at (720) 302-3513.",
        variant: "destructive",
      });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
      if (!allowedTypes.includes(file.type)) {
        toast({
          title: "Invalid File Type",
          description: "Please upload a PDF, JPG, or PNG file.",
          variant: "destructive",
        });
        return;
      }
      
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File Too Large",
          description: "Please upload a file smaller than 10MB.",
          variant: "destructive",
        });
        return;
      }
      
      setSelectedFile(file);
    }
  };

  const removeFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.firstName || !formData.lastName || !formData.email || !formData.phone || !formData.serviceType) {
      toast({
        title: "Required fields missing",
        description: "Please fill in your name, email, phone, and service type.",
        variant: "destructive",
      });
      return;
    }

    quoteMutation.mutate({ 
      ...formData, 
      quoteFile: selectedFile || undefined 
    });
  };

  const handleInputChange = (field: keyof QuoteComparisonData, value: string) => {
    if (!formStarted) {
      setFormStarted(true);
      trackFormStart('quote_comparison');
    }
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <section className="py-20 bg-gradient-to-br from-gray-50 via-white to-gray-50 relative overflow-hidden" id="quote-comparison">
      <div 
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage: `url("data:image/svg+xml,<svg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'><g fill='none' fill-rule='evenodd'><g fill='%23186b6b' fill-opacity='0.1'><circle cx='30' cy='30' r='2'/></g></g></svg>")`,
          backgroundSize: '60px 60px'
        }}
      />
      
      <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center bg-red-accent/10 rounded-full px-6 py-3 mb-6">
            <Target className="w-5 h-5 text-red-accent mr-2" />
            <span className="text-red-accent font-bold text-sm">PRICE MATCH GUARANTEE</span>
          </div>
          <h2 className="text-4xl lg:text-6xl font-bold text-gray-900 mb-6">
            We'll <span className="text-red-accent">Match or Beat</span> Almost Every Quote
          </h2>
          <p className="text-xl text-gray-600 max-w-4xl mx-auto leading-relaxed">
            Upload a competitor's quote and we'll review it to either match the price or beat it - 
            all without a home visit. Get the best deal on your HVAC project guaranteed.
          </p>
        </div>

        <Card className="bg-white shadow-2xl overflow-hidden border-0 relative">
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-red-accent to-teal-primary"></div>
          
          <CardContent className="p-10 lg:p-16">
            <div className="grid lg:grid-cols-3 gap-8 mb-10">
              <div className="text-center p-6 bg-red-accent/5 rounded-2xl">
                <FileText className="w-12 h-12 text-red-accent mx-auto mb-4" />
                <h3 className="font-bold text-lg mb-2">Upload Quote</h3>
                <p className="text-gray-600">Share your competitor's written estimate</p>
              </div>
              <div className="text-center p-6 bg-teal-primary/5 rounded-2xl">
                <DollarSign className="w-12 h-12 text-teal-primary mx-auto mb-4" />
                <h3 className="font-bold text-lg mb-2">We Review</h3>
                <p className="text-gray-600">Our experts analyze the quote within 24 hours</p>
              </div>
              <div className="text-center p-6 bg-blue-primary/5 rounded-2xl">
                <Target className="w-12 h-12 text-blue-primary mx-auto mb-4" />
                <h3 className="font-bold text-lg mb-2">Better Price</h3>
                <p className="text-gray-600">Get our matching or better price guarantee</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">First Name *</Label>
                  <Input
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => handleInputChange("firstName", e.target.value)}
                    placeholder="John"
                    className="focus:ring-2 focus:ring-red-accent"
                    required
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">Last Name *</Label>
                  <Input
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => handleInputChange("lastName", e.target.value)}
                    placeholder="Smith"
                    className="focus:ring-2 focus:ring-red-accent"
                    required
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">Email Address *</Label>
                  <Input
                    type="email"
                    value={formData.email}
                    onChange={(e) => handleInputChange("email", e.target.value)}
                    placeholder="john@example.com"
                    className="focus:ring-2 focus:ring-red-accent"
                    required
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">Phone Number *</Label>
                  <Input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => handleInputChange("phone", e.target.value)}
                    placeholder="(720) 555-0123"
                    className="focus:ring-2 focus:ring-red-accent"
                    required
                  />
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium text-gray-700 mb-2">Street Address</Label>
                <Input
                  type="text"
                  value={formData.address}
                  onChange={(e) => handleInputChange("address", e.target.value)}
                  placeholder="123 Main St"
                  className="focus:ring-2 focus:ring-red-accent"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">City</Label>
                  <Input
                    type="text"
                    value={formData.city}
                    onChange={(e) => handleInputChange("city", e.target.value)}
                    placeholder="Denver"
                    className="focus:ring-2 focus:ring-red-accent"
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">State</Label>
                  <Input
                    type="text"
                    value={formData.state}
                    onChange={(e) => handleInputChange("state", e.target.value)}
                    placeholder="CO"
                    maxLength={2}
                    className="focus:ring-2 focus:ring-red-accent"
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">ZIP</Label>
                  <Input
                    type="text"
                    value={formData.zip}
                    onChange={(e) => handleInputChange("zip", e.target.value)}
                    placeholder="80202"
                    maxLength={10}
                    className="focus:ring-2 focus:ring-red-accent"
                  />
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium text-gray-700 mb-2">Service Type *</Label>
                <Select value={formData.serviceType} onValueChange={(value) => handleInputChange("serviceType", value)}>
                  <SelectTrigger className="focus:ring-2 focus:ring-red-accent">
                    <SelectValue placeholder="Select service type..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="furnace-installation">Furnace Installation</SelectItem>
                    <SelectItem value="ac-installation">AC Installation</SelectItem>
                    <SelectItem value="heat-pump-installation">Heat Pump Installation</SelectItem>
                    <SelectItem value="ductwork">Ductwork Installation/Repair</SelectItem>
                    <SelectItem value="system-replacement">Complete HVAC System</SelectItem>
                    <SelectItem value="furnace-repair">Furnace Repair</SelectItem>
                    <SelectItem value="ac-repair">AC Repair</SelectItem>
                    <SelectItem value="maintenance-contract">Maintenance Contract</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">Competitor Company Name</Label>
                  <Input
                    type="text"
                    value={formData.competitorName}
                    onChange={(e) => handleInputChange("competitorName", e.target.value)}
                    placeholder="e.g., Applewood Plumbing"
                    className="focus:ring-2 focus:ring-red-accent"
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium text-gray-700 mb-2">Quote Amount</Label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                    <Input
                      type="text"
                      value={formData.quoteAmount}
                      onChange={(e) => handleInputChange("quoteAmount", e.target.value)}
                      placeholder="5,200"
                      className="pl-10 focus:ring-2 focus:ring-red-accent"
                    />
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium text-gray-700 mb-2">Project Description / Notes</Label>
                <Textarea
                  rows={4}
                  value={formData.description}
                  onChange={(e) => handleInputChange("description", e.target.value)}
                  placeholder="Describe the work included in the competitor's quote..."
                  className="focus:ring-2 focus:ring-red-accent"
                />
              </div>

              <div>
                <Label className="text-sm font-medium text-gray-700 mb-2">Upload Competitor Quote (Optional)</Label>
                {!selectedFile ? (
                  <div 
                    className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center bg-gray-50 hover:bg-gray-100 cursor-pointer transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                    <h3 className="text-lg font-semibold text-gray-700 mb-2">Upload Competitor Quote</h3>
                    <p className="text-gray-500 mb-2">Click to select PDF, JPG, or PNG files</p>
                    <p className="text-sm text-gray-400">Maximum file size: 10MB</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                  </div>
                ) : (
                  <div className="border-2 border-green-300 rounded-lg p-4 bg-green-50">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center">
                        <FileText className="w-8 h-8 text-green-600 mr-3" />
                        <div>
                          <p className="font-medium text-green-800">{selectedFile.name}</p>
                          <p className="text-sm text-green-600">
                            {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={removeFile}
                        className="text-red-600 hover:text-red-800 hover:bg-red-50"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <Button
                type="submit"
                className="w-full bg-red-accent text-white py-4 text-lg font-semibold hover:bg-red-light disabled:opacity-50"
                disabled={quoteMutation.isPending}
              >
                {quoteMutation.isPending ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Target className="w-5 h-5 mr-2" />
                    Submit for Price Match
                  </>
                )}
              </Button>

              <div className="text-center text-sm text-gray-500">
                <p>We'll review your quote and respond within 24 hours with our best price</p>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
