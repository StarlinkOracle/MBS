import { Button } from "@/components/ui/button";
import { Calendar, Calculator, CheckCircle, MapPin } from "lucide-react";
import { trackSectionView, trackEvent } from "@/lib/analytics";
import { useEffect } from "react";

export default function Hero() {
  useEffect(() => {
    trackSectionView('hero');
  }, []);

  const handleScheduleClick = () => {
    trackEvent('cta_click', 'conversion', 'hero_schedule_button');
    document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="relative bg-gray-100 text-navy-dark overflow-hidden">
      {/* Large hero image background */}
      <div className="absolute inset-0">
        <img
          src="https://images.unsplash.com/photo-1619856699906-09e1f58c98b1?ixlib=rb-4.0.3&auto=format&fit=crop&w=2000&h=1000"
          alt="Professional HVAC services in Denver Colorado with Rocky Mountains backdrop - Russell Comfort Solutions service area"
          className="w-full h-full object-cover opacity-20"
        />
        <div className="absolute inset-0 bg-gray-100/95"></div>
      </div>

      {/* Subtle pattern overlay */}
      <div 
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage: `url("data:image/svg+xml,<svg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'><g fill='none' fill-rule='evenodd'><g fill='%23ffffff' fill-opacity='0.1'><circle cx='30' cy='30' r='2'/></g></g></svg>")`,
          backgroundSize: '60px 60px'
        }}
      />
      
      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-10">
        <div className="text-center max-w-5xl mx-auto">
          {/* Service badge */}
          <div className="inline-flex items-center bg-red-accent/10 backdrop-blur-sm rounded-full px-6 py-3 mb-8 border border-red-accent/30">
            <div className="w-3 h-3 bg-red-accent rounded-full mr-3 animate-pulse"></div>
            <span className="text-sm font-bold tracking-wide text-red-accent">AVAILABLE 24/7 • EMERGENCY SERVICE</span>
          </div>

          {/* Main heading */}
          <h1 className="text-5xl sm:text-6xl lg:text-8xl font-bold leading-tight mb-8">
            <span className="text-blue-primary">RUSSELL</span>{" "}
            <span className="text-navy-dark">COMFORT</span>
            <br />
            <span className="text-red-accent text-4xl sm:text-5xl lg:text-6xl">SOLUTIONS</span>
          </h1>

          {/* Subheading */}
          <div className="text-xl sm:text-2xl lg:text-3xl font-semibold mb-6">
            <span className="text-blue-primary">HEATING</span>{" "}
            <span className="text-gray-500">•</span>{" "}
            <span className="text-blue-primary">VENTILATION</span>{" "}
            <span className="text-gray-500">•</span>{" "}
            <span className="text-blue-primary">AIR CONDITIONING</span>
          </div>

          {/* Slogan */}
          <div className="text-2xl lg:text-3xl font-bold text-blue-primary mb-4 italic">
            "Experience the Russell Comfort difference for yourself"
          </div>

          {/* Description */}
          <p className="text-lg lg:text-xl text-gray-600 mb-12 max-w-4xl mx-auto leading-relaxed">
            Colorado's 5 star rated HVAC professionals serving the Denver Metro area and Front Range.<br />
            Expert installation, repair, and maintenance for residential and commercial properties.
          </p>

          {/* CTA Button */}
          <div className="flex justify-center px-4">
            <Button 
              size="lg" 
              className="bg-red-accent text-white hover:bg-red-light shadow-2xl hover:shadow-red-accent/50 transform hover:scale-105 transition-all duration-300 px-4 sm:px-8 lg:px-10 py-4 sm:py-5 lg:py-6 text-sm sm:text-lg lg:text-xl font-bold max-w-full"
              onClick={handleScheduleClick}
            >
              <Calendar className="w-4 h-4 sm:w-5 sm:h-5 lg:w-6 lg:h-6 mr-2 sm:mr-3 flex-shrink-0" />
              <span className="text-center leading-tight">
                SCHEDULE A SERVICE OR FREE ESTIMATE
              </span>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
