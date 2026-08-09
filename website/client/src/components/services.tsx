import { Wrench, Home, Snowflake, Wind, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function Services() {
  const services = [
    {
      icon: Wrench,
      title: "Furnace & HVAC Repair",
      description: "Expert furnace repair and HVAC system diagnostics in Denver Metro Area. Emergency heating repairs, AC troubleshooting, and preventive maintenance. $99 diagnostic fee applied toward repair. EPA-certified technicians with upfront pricing.",
      price: "$99 Diagnostic Fee",
      coverage: "Denver Metro Area"
    },
    {
      icon: Home,
      title: "HVAC Installation & Replacement", 
      description: "Complete furnace installation, AC system replacement, and high-efficiency HVAC upgrades. Licensed Colorado contractor with manufacturer warranties and energy-efficient solutions.",
      price: "Free Estimates",
      coverage: "Residential & Commercial"
    },
    {
      icon: Snowflake,
      title: "24/7 Emergency HVAC Service",
      description: "Round-the-clock emergency HVAC repair throughout Denver, Boulder, Aurora, and surrounding areas. Fast response for heating and cooling emergencies. Call (720) 302-3513.",
      price: "24/7 Availability", 
      coverage: "All Metro Areas"
    },
    {
      icon: Wind,
      title: "Indoor Air Quality & Ductwork",
      description: "Professional duct cleaning, air quality testing, air purification systems, and ductwork repair. Improve home comfort and energy efficiency with certified HVAC specialists.",
      price: "Competitive Rates",
      coverage: "Denver & Suburbs"
    },
  ];

  return (
    <section className="py-16 bg-gray-50" id="services">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
            Denver HVAC Services | Heating & Cooling Repair Colorado
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Professional HVAC contractor serving Denver Metro Area with emergency furnace repair, AC installation, and indoor air quality solutions. Licensed and insured Colorado heating and cooling experts.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {services.map((service, index) => {
            const IconComponent = service.icon;
            const bgColor = index % 2 === 0 ? "bg-teal-primary" : "bg-red-accent";
            
            return (
              <Card key={service.title} className="hover:shadow-lg transition-shadow border border-gray-100">
                <CardContent className="p-6">
                  <div className={`w-12 h-12 ${bgColor} rounded-lg flex items-center justify-center mb-4`}>
                    <IconComponent className="w-6 h-6 text-white" />
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">{service.title}</h3>
                  <p className="text-gray-600 mb-3">{service.description}</p>
                  <div className="flex justify-between items-center mb-4 text-sm">
                    <span className="font-semibold text-teal-primary">{service.price}</span>
                    <span className="text-gray-500">{service.coverage}</span>
                  </div>
                  {service.title === "Emergency Service" ? (
                    <a 
                      href="tel:7203025513" 
                      className="text-red-accent font-semibold hover:text-red-light transition-colors inline-flex items-center"
                    >
                      Call Now <ArrowRight className="w-4 h-4 ml-1" />
                    </a>
                  ) : (
                    <a 
                      href="#contact" 
                      className="text-teal-primary font-semibold hover:text-teal-dark transition-colors inline-flex items-center"
                    >
                      Get Quote <ArrowRight className="w-4 h-4 ml-1" />
                    </a>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
