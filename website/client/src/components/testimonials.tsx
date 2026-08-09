import { Card, CardContent } from "@/components/ui/card";
import { Star, Quote } from "lucide-react";

export default function Testimonials() {
  const testimonials = [
    {
      name: "Brad N.",
      text: "During our A/C installation this team worked very hard to make sure the equipment was exactly what we needed. There was no up-sell. Their appointment times were prompt and communication throughout the process was excellent as they patiently answered all of our questions. The entire process from beginning to end was professional and the guys were all very friendly. Would highly recommend!",
      service: "A/C Installation",
      stars: 5
    },
    {
      name: "Camille L.",
      text: "I had a larger company tell me my unit could not be fixed and would need to be replaced. Cade and company came in and made it work for a very reasonable price!! When I first called they were quick to respond and to get my service scheduled. Extremely professional and courteous, I highly recommend this locally owned small business!",
      service: "HVAC Repair",
      stars: 5
    },
    {
      name: "Kathleen M.",
      text: "Cade and his brother were amazing! Quick response, same day service! I am so happy to find a local small business HVAC company I can use for my listings and feel confident to refer to my clients!",
      service: "Same Day Service",
      stars: 5
    }
  ];

  return (
    <section className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center bg-yellow-100 rounded-full px-4 py-2 mb-4">
            <Star className="w-4 h-4 text-yellow-500 mr-2" />
            <span className="text-yellow-700 font-semibold text-sm">CUSTOMER TESTIMONIALS</span>
          </div>
          <h2 className="text-4xl lg:text-5xl font-bold text-gray-900 mb-6">
            What Our <span className="text-teal-primary">Colorado Customers</span> Say
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            Don't just take our word for it. See what families across the Front Range say about our HVAC services.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {testimonials.map((testimonial, index) => (
            <Card key={testimonial.name} className="bg-gray-50 border-0 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105">
              <CardContent className="p-8">
                <div className="flex items-center justify-between mb-4">
                  <Quote className="w-8 h-8 text-teal-primary" />
                  <div className="flex items-center">
                    {[...Array(testimonial.stars)].map((_, i) => (
                      <Star key={i} className="w-5 h-5 text-yellow-400 fill-current" />
                    ))}
                  </div>
                </div>
                
                <p className="text-gray-700 text-lg leading-relaxed mb-6 italic">
                  "{testimonial.text}"
                </p>
                
                <div className="border-t border-gray-200 pt-4">
                  <div className="font-bold text-gray-900 text-lg">{testimonial.name}</div>
                  <div className="text-teal-primary font-medium text-sm mt-1">{testimonial.service}</div>
                  <div className="flex items-center mt-2">
                    <span className="text-yellow-500 font-semibold text-sm mr-1">5 Stars</span>
                    <span className="text-gray-500 text-xs">• Verified Customer</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Call to action */}
        <div className="mt-16 text-center">
          <div className="bg-gradient-to-r from-teal-primary to-teal-dark rounded-2xl p-8 text-white">
            <h3 className="text-2xl font-bold mb-4">Join Our Satisfied Customers</h3>
            <p className="text-lg">Professional HVAC services you can trust</p>
          </div>
        </div>
      </div>
    </section>
  );
}