import { Award, Clock, Shield, DollarSign } from "lucide-react";

export default function WhyChooseUs() {
  const features = [
    {
      icon: Award,
      title: "Licensed & Certified",
      description: "EPA certified technicians with ongoing training on the latest HVAC technology and practices."
    },
    {
      icon: Clock,
      title: "Fast Response",
      description: "Same-day service available with 24/7 emergency support for urgent HVAC issues."
    },
    {
      icon: Shield,
      title: "Satisfaction Guaranteed",
      description: "100% satisfaction guarantee on all services with comprehensive warranties on installations."
    },
    {
      icon: DollarSign,
      title: "Transparent Pricing",
      description: "Upfront, honest pricing with no hidden fees. Free estimates on all replacement projects."
    }
  ];

  return (
    <section className="py-16 bg-teal-primary text-navy-dark relative overflow-hidden">
      {/* Background Pattern */}
      <div 
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: `url("data:image/svg+xml,<svg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'><g fill='none' fill-rule='evenodd'><g fill='%23ffffff' fill-opacity='0.1'><circle cx='20' cy='20' r='3'/></g></g></svg>")`,
          backgroundSize: '40px 40px'
        }}
      />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold mb-4">
            Why Colorado Families Choose Russell Comfort Solutions
          </h2>
          <p className="text-xl text-white max-w-3xl mx-auto">
            We're not just another HVAC company. We're your neighbors, committed to keeping Colorado homes comfortable year-round.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {features.map((feature) => {
            const IconComponent = feature.icon;
            return (
              <div key={feature.title} className="text-center">
                <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4">
                  <IconComponent className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-semibold mb-2">{feature.title}</h3>
                <p className="text-white">{feature.description}</p>
              </div>
            );
          })}
        </div>


      </div>
    </section>
  );
}
