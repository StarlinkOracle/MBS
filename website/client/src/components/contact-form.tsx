import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { getAttributionSnapshot, fireConversionEvent } from "@/lib/attribution";
import { trackSectionView, trackFormStart, trackFormSubmit } from "@/lib/analytics";
import { Phone, Mail, MapPin, Clock, CheckCircle, Loader2, Calendar } from "lucide-react";
import { useLocation } from "wouter";

interface ContactFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  serviceType: string;
  preferredDate: string;
  preferredTime: string;
  message: string;
}

const initialFormData: ContactFormData = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  state: "CO",
  zip: "",
  serviceType: "",
  preferredDate: "",
  preferredTime: "",
  message: "",
};

export default function ContactForm() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [formData, setFormData] = useState<ContactFormData>(initialFormData);
  const [formStarted, setFormStarted] = useState(false);

  useEffect(() => {
    trackSectionView('contact_form');
  }, []);

  const contactMutation = useMutation({
    mutationFn: async (data: ContactFormData) => {
      const attribution = getAttributionSnapshot();
      const payload = {
        ...data,
        utmSource: attribution.utmSource,
        utmMedium: attribution.utmMedium,
        utmCampaign: attribution.utmCampaign,
        utmContent: attribution.utmContent,
        utmTerm: attribution.utmTerm,
        gclid: attribution.gclid,
        gbraid: attribution.gbraid,
        wbraid: attribution.wbraid,
        fbclid: attribution.fbclid,
        landingUrl: attribution.landingUrl,
        referrerUrl: attribution.referrerUrl,
        visitorId: attribution.visitorId,
      };

      const res = await apiRequest("POST", "/api/contact", payload);
      return res.json();
    },
    onSuccess: (data) => {
      trackFormSubmit('contact_form');
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

  const handleInputChange = (field: keyof ContactFormData, value: string) => {
    if (!formStarted) {
      setFormStarted(true);
      trackFormStart('contact_form');
    }
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.firstName || !formData.lastName || !formData.email || !formData.phone) {
      toast({
        title: "Required fields missing",
        description: "Please fill in your name, email, and phone number.",
        variant: "destructive",
      });
      return;
    }

    contactMutation.mutate(formData);
  };

  return (
    <section className="py-16 bg-gradient-to-br from-blue-primary to-blue-dark" id="contact">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
            Get Your Free Quote Today
          </h2>
          <p className="text-xl text-navy-dark max-w-3xl mx-auto">
            Ready to experience the Russell Comfort difference? Contact us for expert HVAC services and competitive pricing.
          </p>
        </div>

        <Card className="max-w-6xl mx-auto shadow-2xl border-0">
          <div className="grid lg:grid-cols-2 gap-0">
            <div className="p-8">
              <div className="mb-6">
                <h3 className="text-2xl font-bold text-gray-900 mb-2">Book a Service or Free Estimate</h3>
                <p className="text-gray-600">Fill out the form below and we'll get back to you within 24 hours.</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-sm font-medium text-gray-700">First Name *</Label>
                    <Input
                      type="text"
                      value={formData.firstName}
                      onChange={(e) => handleInputChange("firstName", e.target.value)}
                      placeholder="John"
                      required
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-gray-700">Last Name *</Label>
                    <Input
                      type="text"
                      value={formData.lastName}
                      onChange={(e) => handleInputChange("lastName", e.target.value)}
                      placeholder="Smith"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-sm font-medium text-gray-700">Phone *</Label>
                    <Input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => handleInputChange("phone", e.target.value)}
                      placeholder="(720) 555-0123"
                      required
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-gray-700">Email *</Label>
                    <Input
                      type="email"
                      value={formData.email}
                      onChange={(e) => handleInputChange("email", e.target.value)}
                      placeholder="john@example.com"
                      required
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-medium text-gray-700">Street Address</Label>
                  <Input
                    type="text"
                    value={formData.address}
                    onChange={(e) => handleInputChange("address", e.target.value)}
                    placeholder="123 Main St"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-sm font-medium text-gray-700">City</Label>
                    <Input
                      type="text"
                      value={formData.city}
                      onChange={(e) => handleInputChange("city", e.target.value)}
                      placeholder="Denver"
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-gray-700">State</Label>
                    <Input
                      type="text"
                      value={formData.state}
                      onChange={(e) => handleInputChange("state", e.target.value)}
                      placeholder="CO"
                      maxLength={2}
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-gray-700">ZIP</Label>
                    <Input
                      type="text"
                      value={formData.zip}
                      onChange={(e) => handleInputChange("zip", e.target.value)}
                      placeholder="80202"
                      maxLength={10}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-medium text-gray-700">Service Needed</Label>
                  <Select value={formData.serviceType} onValueChange={(value) => handleInputChange("serviceType", value)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a service..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ac-repair">AC Repair</SelectItem>
                      <SelectItem value="furnace-repair">Furnace Repair</SelectItem>
                      <SelectItem value="ac-installation">AC Installation</SelectItem>
                      <SelectItem value="furnace-installation">Furnace Installation</SelectItem>
                      <SelectItem value="maintenance">Maintenance / Tune-up</SelectItem>
                      <SelectItem value="ductwork">Ductwork</SelectItem>
                      <SelectItem value="indoor-air-quality">Indoor Air Quality</SelectItem>
                      <SelectItem value="heat-pump">Heat Pump</SelectItem>
                      <SelectItem value="emergency">Emergency Service</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-sm font-medium text-gray-700">Preferred Date</Label>
                    <Input
                      type="date"
                      value={formData.preferredDate}
                      onChange={(e) => handleInputChange("preferredDate", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-sm font-medium text-gray-700">Preferred Time</Label>
                    <Select value={formData.preferredTime} onValueChange={(value) => handleInputChange("preferredTime", value)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Any time" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="morning">Morning (8am-12pm)</SelectItem>
                        <SelectItem value="afternoon">Afternoon (12pm-4pm)</SelectItem>
                        <SelectItem value="evening">Evening (4pm-6pm)</SelectItem>
                        <SelectItem value="flexible">Flexible</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-medium text-gray-700">Message / Notes</Label>
                  <Textarea
                    value={formData.message}
                    onChange={(e) => handleInputChange("message", e.target.value)}
                    placeholder="Tell us about the issue or what you need..."
                    rows={3}
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full bg-red-accent text-white py-4 text-lg font-semibold hover:bg-red-light disabled:opacity-50"
                  disabled={contactMutation.isPending}
                >
                  {contactMutation.isPending ? (
                    <>
                      <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Calendar className="w-5 h-5 mr-2" />
                      Submit Request
                    </>
                  )}
                </Button>

              </form>
            </div>

            <div className="bg-gradient-to-br from-blue-primary to-blue-dark text-white p-8 lg:rounded-r-lg">
              <div className="h-full flex flex-col">
                <div className="mb-8">
                  <h3 className="text-2xl font-bold mb-4">Get in Touch</h3>
                  <p className="text-black mb-6">
                    Ready to schedule service or have questions? We're here to help with all your HVAC needs.
                  </p>
                </div>

                <div className="space-y-6 flex-1">
                  <div className="flex items-start space-x-4">
                    <Phone className="w-6 h-6 text-teal-light mt-1" />
                    <div>
                      <h4 className="font-semibold text-lg">Call Us</h4>
                      <p className="text-black">(720) 302-3513</p>
                      <p className="text-sm text-black">24/7 Emergency Service</p>
                    </div>
                  </div>

                  <div className="flex items-start space-x-4">
                    <Mail className="w-6 h-6 text-teal-light mt-1" />
                    <div>
                      <h4 className="font-semibold text-lg">Email Us</h4>
                      <p className="text-black">hvac@russellcomfort.com</p>
                      <p className="text-sm text-black">Response within 24 hours</p>
                    </div>
                  </div>

                  <div className="flex items-start space-x-4">
                    <MapPin className="w-6 h-6 text-teal-light mt-1" />
                    <div>
                      <h4 className="font-semibold text-lg">Service Area</h4>
                      <p className="text-black">Denver Metro & Surrounding Areas</p>
                      <p className="text-sm text-black">Licensed in Colorado</p>
                    </div>
                  </div>

                  <div className="flex items-start space-x-4">
                    <Clock className="w-6 h-6 text-teal-light mt-1" />
                    <div>
                      <h4 className="font-semibold text-lg">Business Hours</h4>
                      <p className="text-black">Mon-Fri: 8AM - 6PM</p>
                      <p className="text-black">Sat: 8AM - 3PM</p>
                      <p className="text-sm text-black">Emergency service available 24/7</p>
                    </div>
                  </div>

                  <div className="border-t border-blue-light pt-6 mt-8">
                    <a
                      href="tel:7203025513"
                      className="inline-flex items-center justify-center w-full bg-red-accent hover:bg-red-light text-white font-bold py-4 px-6 rounded-lg transition-colors text-lg"
                    >
                      <Phone className="w-5 h-5 mr-2" />
                      Call Now: (720) 302-3513
                    </a>
                  </div>
                </div>

                <div className="mt-8 grid grid-cols-2 gap-4">
                  <div className="text-center p-4 bg-white/10 rounded-lg">
                    <div className="font-bold text-lg text-black">Licensed</div>
                    <div className="text-sm text-black">& Insured</div>
                  </div>
                  <div className="text-center p-4 bg-white/10 rounded-lg">
                    <div className="font-bold text-lg text-black">EPA</div>
                    <div className="text-sm text-black">Certified</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}
