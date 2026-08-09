import { Phone, MapPin, Clock, Star } from "lucide-react";
import { useEffect } from "react";

export default function GoogleMyBusinessSignals() {
  useEffect(() => {
    // Add click-to-call tracking for GMB signals
    const handleCallClick = () => {
      // This helps Google understand call conversion from your website
      if (typeof window !== 'undefined' && (window as any).gtag) {
        (window as any).gtag('event', 'phone_call', {
          event_category: 'contact',
          event_label: 'header_phone_click'
        });
      }
    };

    const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
    phoneLinks.forEach(link => {
      link.addEventListener('click', handleCallClick);
    });

    return () => {
      phoneLinks.forEach(link => {
        link.removeEventListener('click', handleCallClick);
      });
    };
  }, []);

  return (
    <section className="py-8 bg-teal-primary text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid md:grid-cols-4 gap-6 text-center">
          {/* Google My Business NAP Consistency */}
          <div className="flex flex-col items-center">
            <MapPin className="w-8 h-8 mb-2" />
            <h3 className="font-semibold mb-1">Service Area</h3>
            <p className="text-sm opacity-90">Denver Metro Area</p>
            <p className="text-xs opacity-75">Licensed & Insured</p>
          </div>

          <div className="flex flex-col items-center">
            <Phone className="w-8 h-8 mb-2" />
            <h3 className="font-semibold mb-1">Call Now</h3>
            <a 
              href="tel:7203025513" 
              className="text-sm hover:text-yellow-200 transition-colors"
              itemProp="telephone"
            >
              (720) 302-3513
            </a>
            <p className="text-xs opacity-75">24/7 Emergency</p>
          </div>

          <div className="flex flex-col items-center">
            <Clock className="w-8 h-8 mb-2" />
            <h3 className="font-semibold mb-1">Business Hours</h3>
            <p className="text-sm opacity-90">Mon-Fri: 8AM-6PM</p>
            <p className="text-xs opacity-75">Sat: 8AM-3PM</p>
          </div>

          <div className="flex flex-col items-center">
            <Star className="w-8 h-8 mb-2" />
            <h3 className="font-semibold mb-1">5 Star Rated</h3>
            <div className="flex items-center space-x-1">
              <span className="text-sm font-medium">Professional Service</span>
            </div>
            <p className="text-xs opacity-75">Customer Testimonials</p>
          </div>
        </div>

        {/* Google My Business CTA */}
        <div className="text-center mt-8">
          <p className="text-sm opacity-90 mb-2">
            Find us on Google Maps for directions and reviews
          </p>
          <a 
            href="https://maps.google.com/maps?q=Russell+Comfort+Solutions+Denver+CO" 
            target="_blank" 
            rel="noopener noreferrer"
            className="inline-flex items-center text-yellow-200 hover:text-yellow-100 transition-colors text-sm font-medium"
          >
            <MapPin className="w-4 h-4 mr-1" />
            View on Google Maps
          </a>
        </div>
      </div>
    </section>
  );
}