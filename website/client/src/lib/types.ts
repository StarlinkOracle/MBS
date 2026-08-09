export interface ServiceArea {
  name: string;
  featured?: boolean;
}

export interface Service {
  id: string;
  title: string;
  description: string;
  icon: string;
  price?: string;
  features?: string[];
  image?: string;
}

export interface ContactFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  serviceType?: string;
  message?: string;
}
