import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, X, Phone, Clock, Mail, Facebook, Linkedin, Instagram, Shield } from "lucide-react";
import { FaXTwitter } from "react-icons/fa6";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import logoPath from "@assets/official_logo_transparent_1749387933706.png";

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);

  const navigationItems = [
    { name: "Home", href: "#", external: false },
    { name: "Services", href: "#services", external: false },
    { name: "Price Match", href: "#quote-comparison", external: false },
    { name: "About", href: "#about", external: false },
    { name: "Service Areas", href: "#service-areas", external: false },
    { name: "Blog", href: "https://hvacolorado.com", external: true },
    { name: "Contact", href: "#contact", external: false },
  ];

  return (
    <header className="bg-white shadow-lg border-b border-gray-200 sticky top-0 z-50 backdrop-blur-sm bg-white/95">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Enhanced Top Bar */}
        <div className="flex justify-between items-center py-3 border-b border-gray-100 text-sm">
          <div className="flex items-center space-x-8">
            <span className="text-gray-700 flex items-center font-medium">
              <Clock className="w-4 h-4 mr-2 text-teal-primary" />
              Mon-Fri: 8am-6pm | Sat: 8am-3pm
            </span>
            <span className="text-gray-700 hidden md:flex items-center font-medium">
              <Mail className="w-4 h-4 mr-2 text-teal-primary" />
              hvac@russellcomfort.com
            </span>
          </div>
          <div className="flex items-center space-x-6">
            <div className="flex space-x-3">
              <a href="https://www.facebook.com/profile.php?id=61573512367885" target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-teal-primary transition-colors">
                <Facebook className="w-4 h-4" />
              </a>
              <a href="https://www.instagram.com/russellcomfortsolutions" target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-teal-primary transition-colors">
                <Instagram className="w-4 h-4" />
              </a>
              <a href="https://x.com/HVAColorado" target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-teal-primary transition-colors">
                <FaXTwitter className="w-4 h-4" />
              </a>
              <a href="https://www.linkedin.com/in/russell-comfort-solutions-251377365/" target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-teal-primary transition-colors">
                <Linkedin className="w-4 h-4" />
              </a>
            </div>
            <div className="flex items-center space-x-4">
              <div className="flex items-center bg-green-100 text-green-800 px-3 py-1 rounded-full text-sm font-medium">
                <Shield className="w-4 h-4 mr-1" />
                Licensed & Insured
              </div>
              <a
                href="tel:7203025513"
                className="text-red-accent font-bold hover:text-red-light transition-colors flex items-center text-lg"
              >
                <Phone className="w-5 h-5 mr-2" />
                (720) 302-3513
              </a>
            </div>
          </div>
        </div>

        {/* Enhanced Main Navigation */}
        <nav className="flex justify-between items-center py-6">
          <div className="flex items-center">
            <div className="flex items-center space-x-3">
              <img 
                src={logoPath} 
                alt="Russell Comfort Solutions Logo" 
                className="h-20 w-auto hover:scale-105 transition-transform duration-200"
              />
            </div>
          </div>

          {/* Enhanced Desktop Navigation */}
          <div className="hidden lg:flex items-center space-x-10">
            {navigationItems.map((item) => (
              <a
                key={item.name}
                href={item.href}
                {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="text-navy-dark hover:text-teal-primary transition-colors font-semibold text-lg relative group"
              >
                {item.name}
                <span className="absolute bottom-0 left-0 w-0 h-0.5 bg-teal-primary transition-all duration-300 group-hover:w-full"></span>
              </a>
            ))}
            <Button 
              className="bg-red-accent text-white hover:bg-red-light shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200 px-6 py-3 text-lg font-semibold"
              onClick={() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Book Service
            </Button>
          </div>

          {/* Mobile Menu */}
          <div className="lg:hidden">
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Menu className="h-6 w-6" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[280px]">
                <div className="flex flex-col space-y-4 mt-8">
                  {navigationItems.map((item) => (
                    <a
                      key={item.name}
                      href={item.href}
                      {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="text-gray-700 hover:text-teal-primary transition-colors font-medium py-2"
                      onClick={() => !item.external && setIsOpen(false)}
                    >
                      {item.name}
                    </a>
                  ))}
                  <div className="border-t pt-4 mt-4">
                    <div className="flex items-center justify-center bg-green-100 text-green-800 px-3 py-2 rounded-full text-sm font-medium mb-4">
                      <Shield className="w-4 h-4 mr-1" />
                      Licensed & Insured
                    </div>
                    <a
                      href="tel:7203025513"
                      className="text-red-accent font-bold hover:text-red-light transition-colors flex items-center justify-center text-lg mb-4"
                    >
                      <Phone className="w-5 h-5 mr-2" />
                      (720) 302-3513
                    </a>
                  </div>
                  <Button 
                    className="bg-red-accent text-white hover:bg-red-light"
                    onClick={() => {
                      document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' });
                      setIsOpen(false);
                    }}
                  >
                    Book Service
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </nav>
      </div>
    </header>
  );
}
