import { Facebook, Linkedin, Phone, Mail, MapPin, Instagram, BookOpen } from "lucide-react";
import { FaXTwitter } from "react-icons/fa6";
import logoPath from "@assets/official_logo_transparent_1749387933706.png";

export default function Footer() {
  const services = [
    { name: "Furnace Repair", href: "#services" },
    { name: "AC Installation", href: "#services" },
    { name: "System Maintenance", href: "#services" },
    { name: "Emergency Service", href: "#services" },
    { name: "Price Match", href: "#quote-comparison" },
  ];

  return (
    <footer className="bg-gray-900 text-navy-dark" itemScope itemType="https://schema.org/WPFooter">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          <div className="lg:col-span-2">
            <div className="flex items-center space-x-3 mb-6">
              <img 
                src={logoPath} 
                alt="Russell Comfort Solutions Logo" 
                className="h-12 w-auto"
              />
            </div>
            <p className="text-gray-300 mb-6 max-w-md">
              Colorado's 5 star rated HVAC contractor providing expert heating, cooling, and air quality solutions for residential and commercial properties throughout the Denver Metro Area and Front Range.
            </p>
            <div className="flex space-x-4">
              <a href="https://www.facebook.com/profile.php?id=61573512367885" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-teal-primary transition-colors" aria-label="Facebook">
                <Facebook className="w-5 h-5" />
              </a>
              <a href="https://www.instagram.com/russellcomfortsolutions" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-teal-primary transition-colors" aria-label="Instagram">
                <Instagram className="w-5 h-5" />
              </a>
              <a href="https://x.com/HVAColorado" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-teal-primary transition-colors" aria-label="X (Twitter)">
                <FaXTwitter className="w-5 h-5" />
              </a>
              <a href="https://www.linkedin.com/in/russell-comfort-solutions-251377365/" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-teal-primary transition-colors" aria-label="LinkedIn">
                <Linkedin className="w-5 h-5" />
              </a>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-4 text-white">Services</h3>
            <ul className="space-y-2">
              {services.map((service) => (
                <li key={service.name}>
                  <a href={service.href} className="text-gray-300 hover:text-teal-primary transition-colors">
                    {service.name}
                  </a>
                </li>
              ))}
            </ul>

            <h3 className="text-lg font-semibold mb-3 mt-6 text-white">Resources</h3>
            <ul className="space-y-2">
              <li>
                <a 
                  href="https://hvacolorado.com" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="text-gray-300 hover:text-teal-primary transition-colors inline-flex items-center"
                >
                  <BookOpen className="w-4 h-4 mr-2" />
                  HVAC Blog
                </a>
              </li>
              <li>
                <a href="#faq" className="text-gray-300 hover:text-teal-primary transition-colors">
                  FAQ
                </a>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-semibold mb-4 text-white">Contact</h3>
            <ul className="space-y-3">
              <li>
                <a href="tel:7203025513" className="text-gray-300 hover:text-teal-primary transition-colors flex items-center">
                  <Phone className="w-4 h-4 mr-2 text-teal-primary flex-shrink-0" />
                  (720) 302-3513
                </a>
              </li>
              <li>
                <a href="mailto:hvac@russellcomfort.com" className="text-gray-300 hover:text-teal-primary transition-colors flex items-center">
                  <Mail className="w-4 h-4 mr-2 text-teal-primary flex-shrink-0" />
                  hvac@russellcomfort.com
                </a>
              </li>
              <li className="text-gray-300 flex items-center">
                <MapPin className="w-4 h-4 mr-2 text-teal-primary flex-shrink-0" />
                Denver Metro Area, CO
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-800 mt-8 pt-8 flex flex-col md:flex-row justify-between items-center">
          <div className="text-gray-400 text-sm mb-4 md:mb-0">
            &copy; 2026 Russell Comfort Solutions. All rights reserved.
          </div>
          <div className="flex space-x-6 text-sm">
            <a href="#" className="text-gray-400 hover:text-teal-primary transition-colors">
              Privacy Policy
            </a>
            <a href="#" className="text-gray-400 hover:text-teal-primary transition-colors">
              Terms of Service
            </a>
            <a href="/admin" className="text-gray-600 hover:text-teal-primary transition-colors">
              Admin
            </a>
            <span className="text-gray-400">Licensed & Insured</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
