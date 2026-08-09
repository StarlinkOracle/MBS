import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle } from "lucide-react";
import { useEffect } from "react";

export default function FeaturedServices() {
  // Add service schema to head
  useEffect(() => {
    const serviceSchema = {
      "@context": "https://schema.org",
      "@type": "Service",
      "serviceType": ["HVAC Repair", "Furnace Maintenance", "AC Repair", "Thermostat Installation"],
      "provider": {
        "@type": "HVACBusiness",
        "name": "Russell Comfort Solutions",
        "telephone": "+17203025513",
        "address": {
          "@type": "PostalAddress",
          "addressLocality": "Denver",
          "addressRegion": "CO",
          "addressCountry": "US"
        }
      },
      "areaServed": ["Denver, CO", "Boulder, CO", "Aurora, CO", "Lakewood, CO"],
      "offers": [
        {
          "@type": "Offer",
          "description": "Furnace Tune-Up & Maintenance",
          "price": "150",
          "priceCurrency": "USD"
        },
        {
          "@type": "Offer", 
          "description": "AC Diagnosis & Repair",
          "price": "150",
          "priceCurrency": "USD"
        },
        {
          "@type": "Offer",
          "description": "Smart Thermostat Installation", 
          "price": "199",
          "priceCurrency": "USD"
        }
      ]
    };

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify(serviceSchema);
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, []);

  const featuredServices = [
    {
      title: "Furnace Tune-Up & Maintenance",
      price: "$150",
      originalPrice: "$200",
      image: "/mountain2.png",
      description: "Complete system inspection, cleaning, and optimization to ensure peak performance and efficiency.",
      features: [
        "Complete system inspection",
        "Filter replacement included",
        "Safety checks & testing",
        "Performance optimization"
      ],
      buttonText: "Schedule Service",
      buttonClass: "bg-teal-primary hover:bg-teal-dark",
      badge: "Most Popular"
    },
    {
      title: "AC Diagnosis & Repair",
      price: "$150",
      priceNote: "Service call + diagnostic fee",
      image: "/mountain1.png",
      description: "Professional diagnosis of AC issues with honest repair recommendations and upfront pricing.",
      features: [
        "Complete system diagnosis",
        "Upfront pricing guarantee",
        "No hidden fees ever",
        "Same-day service"
      ],
      buttonText: "Book Diagnosis",
      buttonClass: "bg-red-accent hover:bg-red-light",
      badge: "Emergency Available"
    },
    {
      title: "Smart Thermostat Installation",
      price: "$199",
      originalPrice: "$299",
      priceNote: "Installation + programming included",
      image: "/mountain3.png",
      description: "Upgrade to smart climate control with professional installation and setup of leading thermostat brands.",
      features: [
        "Professional installation",
        "Complete app setup",
        "Personal training session",
        "1-year warranty included"
      ],
      buttonText: "Schedule Install",
      buttonClass: "bg-teal-primary hover:bg-teal-dark",
      badge: "Save $100"
    }
  ];

  return (
    <section className="py-20 bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center bg-teal-primary/10 rounded-full px-4 py-2 mb-4">
            <span className="text-teal-primary font-semibold text-sm">FEATURED SERVICES</span>
          </div>
          <h2 className="text-4xl lg:text-5xl font-bold text-gray-900 mb-6">
            5 Star Rated Denver HVAC Repair & Installation with 
            <span className="text-teal-primary"> Upfront Pricing</span>
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Licensed Colorado HVAC contractors providing furnace repair, AC installation, and emergency heating service in Denver Metro Area. Same-day service with transparent, upfront pricing guaranteed.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {featuredServices.map((service, index) => (
            <Card key={service.title} className={`relative overflow-hidden transition-all duration-300 hover:shadow-2xl ${index === 0 ? 'ring-2 ring-teal-primary lg:scale-105' : 'hover:scale-105'} bg-white`}>
              {service.badge && (
                <div className="absolute top-4 left-4 z-10">
                  <span className={`px-3 py-1 text-xs font-bold rounded-full text-white ${index === 0 ? 'bg-teal-primary' : index === 1 ? 'bg-red-accent' : 'bg-green-500'}`}>
                    {service.badge}
                  </span>
                </div>
              )}
              
              <div className="relative">
                <img
                  src={service.image}
                  alt={`${service.title} in Denver Colorado - Professional HVAC service with mountain backdrop representing Russell Comfort Solutions service area`}
                  className="w-full h-56 object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent"></div>
              </div>
              
              <CardContent className="p-8">
                <h3 className="text-2xl font-bold text-gray-900 mb-4">{service.title}</h3>
                
                <div className="flex items-baseline mb-2">
                  <div className="text-4xl font-bold text-teal-primary">{service.price}</div>
                  {service.originalPrice && (
                    <div className="text-lg text-gray-400 line-through ml-3">{service.originalPrice}</div>
                  )}
                </div>
                
                {service.priceNote && (
                  <div className="text-sm text-gray-500 mb-6">{service.priceNote}</div>
                )}
                
                <p className="text-gray-600 mb-6 leading-relaxed">{service.description}</p>
                
                <ul className="space-y-3 mb-8">
                  {service.features.map((feature) => (
                    <li key={feature} className="flex items-center text-gray-700">
                      <CheckCircle className="w-5 h-5 text-green-500 mr-3 flex-shrink-0" />
                      <span className="font-medium">{feature}</span>
                    </li>
                  ))}
                </ul>
                
                <Button 
                  className={`w-full ${service.buttonClass} text-white py-4 text-lg font-semibold shadow-lg hover:shadow-xl transform transition-all duration-200`}
                  onClick={() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' })}
                >
                  {service.buttonText}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Trust indicators */}
        <div className="mt-16 text-center">
          <div className="inline-flex items-center space-x-8 bg-white rounded-2xl shadow-lg p-6">
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-6 h-6 text-green-500" />
              <span className="font-semibold text-gray-700">Licensed & Insured</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-6 h-6 text-green-500" />
              <span className="font-semibold text-gray-700">Same-Day Service</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-6 h-6 text-green-500" />
              <span className="font-semibold text-gray-700">Upfront Pricing</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
