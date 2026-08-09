import { useEffect } from "react";
import { CheckCircle, Phone, ArrowLeft, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import Header from "@/components/header";
import Footer from "@/components/footer";

export default function ThankYou() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Header />
      <main className="flex-1 flex items-center justify-center py-20 bg-gradient-to-br from-gray-50 to-white">
        <div className="max-w-2xl mx-auto px-4 text-center">
          <Card className="p-10 shadow-xl border-0">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle className="w-10 h-10 text-green-600" />
            </div>

            <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
              Thank You!
            </h1>

            <p className="text-lg text-gray-600 mb-2">
              Your request has been received. A member of the Russell Comfort Solutions team will contact you within 24 hours.
            </p>

            <p className="text-gray-500 mb-8">
              For urgent needs, call us directly:
            </p>

            <a
              href="tel:7203025513"
              className="inline-flex items-center justify-center bg-red-accent hover:bg-red-light text-white font-bold py-4 px-8 rounded-lg transition-colors text-lg mb-8"
            >
              <Phone className="w-5 h-5 mr-2" />
              (720) 302-3513
            </a>

            <div className="border-t border-gray-200 pt-8 flex flex-col sm:flex-row gap-4 justify-center">
              <Button
                variant="outline"
                className="inline-flex items-center"
                onClick={() => window.location.href = "/"}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Home
              </Button>

              <a
                href="https://hvacolorado.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" className="inline-flex items-center w-full">
                  <BookOpen className="w-4 h-4 mr-2" />
                  Read Our HVAC Blog
                </Button>
              </a>
            </div>
          </Card>
        </div>
      </main>
      <Footer />
    </div>
  );
}
