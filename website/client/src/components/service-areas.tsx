import { Button } from "@/components/ui/button";
import { MapPin } from "lucide-react";

export default function ServiceAreas() {
  const serviceAreas = [
    "Denver", "Boulder", "Aurora", "Lakewood",
    "Westminster", "Arvada", "Thornton", "Centennial",
    "Parker", "Littleton", "Wheat Ridge", "Broomfield",
    "Northglenn", "Longmont", "Highlands Ranch", "Castlerock",
    "Golden", "Evergreen", "Brighton"
  ];

  return (
    <section className="py-16 bg-white" id="service-areas">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-6">
              HVAC Services Near Me | Denver Metro Area Coverage
            </h2>
            <p className="text-xl text-gray-600 mb-8">
              Local HVAC contractor providing same-day furnace repair, AC installation, and emergency heating services across Denver, Boulder, Aurora, Westminster, and surrounding Colorado communities. Fast response times available.
            </p>

            {/* Service Areas Grid */}
            <div className="grid md:grid-cols-2 gap-4">
              {serviceAreas.map((area) => (
                <div
                  key={area}
                  className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg"
                >
                  <MapPin className="w-5 h-5 text-teal-primary" />
                  <span className="font-medium text-gray-900">{area}</span>
                </div>
              ))}
            </div>


          </div>

          <div className="relative">
            <img
              src="https://images.unsplash.com/photo-1619856699906-09e1f58c98b1?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&h=600"
              alt="Denver Metro Area HVAC service coverage map showing Rocky Mountains - Russell Comfort Solutions serves Denver, Boulder, Aurora, Westminster and surrounding Colorado cities"
              className="rounded-2xl shadow-xl w-full h-auto"
              loading="lazy"
              decoding="async"
            />

            {/* Service Coverage Badge */}
            <div className="absolute -bottom-4 -right-4 bg-white rounded-xl p-4 shadow-lg">
              <div className="text-center">
                <div className="text-2xl font-bold text-teal-primary">50+</div>
                <div className="text-sm text-gray-600">Cities Served</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
