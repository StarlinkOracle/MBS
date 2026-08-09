import Header from "@/components/header";
import Hero from "@/components/hero";
import Services from "@/components/services";
import FeaturedServices from "@/components/featured-services";
import AboutUs from "@/components/about-us";
import WhyChooseUs from "@/components/why-choose-us";
import Testimonials from "@/components/testimonials";
import ServiceAreas from "@/components/service-areas";
import QuoteComparison from "@/components/quote-comparison";
import ContactForm from "@/components/contact-form";
import GoogleMyBusinessSignals from "@/components/google-my-business-signals";
import GEOOptimization from "@/components/geo-optimization";
import AIFAQSection from "@/components/ai-faq-section";
import Footer from "@/components/footer";

export default function Home() {
  return (
    <div className="min-h-screen bg-white">
      <Header />
      <Hero />
      <Services />
      <FeaturedServices />
      <AboutUs />
      <QuoteComparison />
      <WhyChooseUs />
      <Testimonials />
      <ServiceAreas />
      <AIFAQSection />
      <GoogleMyBusinessSignals />
      <ContactForm />
      <GEOOptimization />
      <Footer />
    </div>
  );
}
