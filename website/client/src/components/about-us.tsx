import { Card, CardContent } from "@/components/ui/card";
import { Users, Heart, Shield } from "lucide-react";

export default function AboutUs() {
  return (
    <section id="about" className="py-20 bg-gradient-to-b from-white to-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center bg-teal-primary/10 rounded-full px-4 py-2 mb-4">
            <span className="text-teal-primary font-semibold text-sm">ABOUT US</span>
          </div>
          <h2 className="text-4xl lg:text-5xl font-bold text-gray-900 mb-6">
            <span className="text-teal-primary">Denver's Most Trusted HVAC Experts</span>
          </h2>
          <p className="text-xl text-gray-600 max-w-3xl mx-auto">
            EPA-certified HVAC contractors serving Colorado since 2020. Licensed, insured, and committed to excellence with satisfied customers throughout the region.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Story Content */}
          <div className="space-y-6">
            <p className="text-lg text-gray-700 leading-relaxed">
              Russell Comfort Solutions was founded by two Colorado-native brothers who grew up understanding just how important reliable heating and cooling is in a place where the weather can change in a heartbeat. What began as a shared passion for mechanical work and helping neighbors stay comfortable year-round has grown into a trusted HVAC company serving homes and businesses across the Denver area.
            </p>
            
            <p className="text-lg text-gray-700 leading-relaxed">
              With a strong work ethic rooted in Colorado values, we built Russell Comfort on a simple promise—show up on time, do the job right, and treat every customer like family. Whether it's a quick repair or a full system install, we bring the same level of care, expertise, and integrity to every job.
            </p>

            <div className="bg-teal-primary/5 border-l-4 border-teal-primary p-6 rounded-r-lg">
              <p className="text-xl font-semibold text-teal-primary mb-2">
                Locally owned. Family founded. Comfort guaranteed.
              </p>
            </div>
          </div>

          {/* Values Cards */}
          <div className="space-y-6">
            <Card className="border-teal-primary/20 hover:shadow-lg transition-all duration-300">
              <CardContent className="p-6">
                <div className="flex items-start space-x-4">
                  <div className="bg-teal-primary/10 p-3 rounded-lg">
                    <Users className="w-6 h-6 text-teal-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Family Values</h3>
                    <p className="text-gray-600">
                      Colorado-native brothers who understand the importance of reliable comfort in our changing climate.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-teal-primary/20 hover:shadow-lg transition-all duration-300">
              <CardContent className="p-6">
                <div className="flex items-start space-x-4">
                  <div className="bg-teal-primary/10 p-3 rounded-lg">
                    <Heart className="w-6 h-6 text-teal-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Community Focus</h3>
                    <p className="text-gray-600">
                      Started with a passion for helping neighbors stay comfortable year-round throughout the Denver area.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-teal-primary/20 hover:shadow-lg transition-all duration-300">
              <CardContent className="p-6">
                <div className="flex items-start space-x-4">
                  <div className="bg-teal-primary/10 p-3 rounded-lg">
                    <Shield className="w-6 h-6 text-teal-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Integrity Promise</h3>
                    <p className="text-gray-600">
                      Show up on time, do the job right, and treat every customer like family with complete transparency.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}