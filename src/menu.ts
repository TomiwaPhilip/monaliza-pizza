// Made-up menu and prices for the exercise. Prices are in Naira (NGN).

export type Category = 'pizza' | 'side' | 'drink';
export type PizzaSize = 'small' | 'medium' | 'large';

export const PIZZA_SIZES: Record<PizzaSize, string> = {
  small: '8 inch, 1 person',
  medium: '10 inch, 2 people',
  large: '12 inch, 3-4 people',
};

export interface MenuItem {
  id: string;
  name: string;
  category: Category;
  description: string;
  /** Pizzas are priced per size; everything else has a single price. */
  prices: Partial<Record<PizzaSize, number>> | { single: number };
}

export const MENU: MenuItem[] = [
  { id: 'margherita', name: 'Margherita', category: 'pizza', description: 'Tomato sauce, mozzarella, basil', prices: { small: 6500, medium: 9000, large: 12000 } },
  { id: 'pepperoni', name: 'Pepperoni', category: 'pizza', description: 'Beef pepperoni, mozzarella', prices: { small: 8000, medium: 11000, large: 14500 } },
  { id: 'bbq-chicken', name: 'BBQ Chicken', category: 'pizza', description: 'Grilled chicken, BBQ sauce, red onion', prices: { small: 8500, medium: 11500, large: 15000 } },
  { id: 'suya-special', name: 'Suya Special', category: 'pizza', description: 'Spicy beef suya, yaji, onions, peppers. House favourite, hot', prices: { small: 9000, medium: 12500, large: 16000 } },
  { id: 'veggie-supreme', name: 'Veggie Supreme', category: 'pizza', description: 'Peppers, sweetcorn, mushrooms, olives, onions', prices: { small: 7000, medium: 9500, large: 13000 } },
  { id: 'meat-lovers', name: 'Meat Lovers', category: 'pizza', description: 'Pepperoni, sausage, minced beef, chicken', prices: { small: 9500, medium: 13000, large: 17000 } },
  { id: 'chicken-wings', name: 'Chicken Wings (6 pcs)', category: 'side', description: 'Peri-peri or BBQ', prices: { single: 4500 } },
  { id: 'garlic-bread', name: 'Garlic Bread', category: 'side', description: '4 slices', prices: { single: 2500 } },
  { id: 'fries', name: 'Fries', category: 'side', description: 'Regular portion', prices: { single: 2000 } },
  { id: 'coke', name: 'Coca-Cola 50cl', category: 'drink', description: 'Chilled', prices: { single: 800 } },
  { id: 'fanta', name: 'Fanta 50cl', category: 'drink', description: 'Chilled', prices: { single: 800 } },
  { id: 'chapman', name: 'Chapman', category: 'drink', description: 'House-made, large cup', prices: { single: 2500 } },
  { id: 'water', name: 'Bottled Water 75cl', category: 'drink', description: 'Chilled', prices: { single: 500 } },
];

export const SHOP = {
  name: 'Monaliza Pizza',
  location: 'Pizza kiosk beside the main food court, Monaliza Park, Abuja',
  pickup_point: 'Collection window on the right side of the kiosk (look for the green "Ready orders" sign)',
  opening_hours: 'Daily 11:00-22:00 (last order 21:30)',
  fulfilment: 'Pickup only. We do not deliver within the park.',
  payment: 'Online via Paystack payment link (card, bank transfer, USSD). We cannot take cash for WhatsApp orders.',
};

export function findMenuItem(id: string): MenuItem | undefined {
  const needle = id.trim().toLowerCase();
  return MENU.find((m) => m.id === needle);
}

export function priceFor(item: MenuItem, size?: PizzaSize): number | undefined {
  if ('single' in item.prices) return item.prices.single;
  if (!size) return undefined;
  return item.prices[size];
}
