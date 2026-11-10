import crypto from 'node:crypto';
import { env } from '../src/config/environment.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { ROLES, USER_STATUS } from '../src/constants/index.js';
import * as M from '../src/models/index.js';
import { counterService } from '../src/modules/counters/counter.service.js';
import { settingsService } from '../src/modules/settings/settings.service.js';
import { hashPassword } from '../src/utils/crypto.js';
import { logger } from '../src/utils/logger.js';

/**
 * Development / demo data. Safe to run repeatedly: every record is looked up by its natural key and only created when missing.
 * Passwords come from SEED_PASSWORD or are generated and printed once; none is hard-coded.
 * In production it refuses to run unless --force-production is given AND SEED_PASSWORD is set.
 */
if (env.isProd && !(process.argv.includes('--force-production') && process.env.SEED_PASSWORD)) {
  logger.error('Refusing to seed in production (needs --force-production and SEED_PASSWORD).');
  process.exit(1);
}
const generated = !process.env.SEED_PASSWORD;
const password = process.env.SEED_PASSWORD ?? `Demo${crypto.randomBytes(6).toString('hex')}9`;
const created = {};
const ensure = async (label, Model, filter, data) => {
  const found = await Model.findOne(filter);
  if (found) return found;
  created[label] = (created[label] ?? 0) + 1;
  return Model.create(data ?? filter);
};

try {
  await connectDatabase();
  const settings = await settingsService.get();
  const hash = await hashPassword(password);
  const user = (email, fullName, role, extra = {}) => ensure('users', M.User, { email }, { email, fullName, role, password: hash, status: USER_STATUS.ACTIVE, isVerified: true, ...extra });

  // PLACEHOLDER rate: confirm the real VAT rate and adjust through /api/tax-rules (rates are versioned, never edited in place).
  await ensure('taxRules', M.TaxRule, { code: 'VAT', effectiveFrom: new Date('2020-01-01') }, { code: 'VAT', name: 'Value added tax', rateBps: 1000, appliesTo: ['ROOM', 'FOOD_AND_BEVERAGE', 'ADDITIONAL_SERVICE', 'SURCHARGE'], effectiveFrom: new Date('2020-01-01') });

  const admin = await user(env.ADMIN_EMAIL || 'admin@hotel.local', env.ADMIN_NAME || 'System Admin', ROLES.ADMIN);
  const m1 = await user('manager1@hotel.local', 'Pham Quan Ly', ROLES.MANAGER, { createdBy: admin._id });
  await user('manager2@hotel.local', 'Le Van Quan', ROLES.MANAGER, { createdBy: admin._id });
  const staffDefs = [['reception', 'Tran Le Tan', 'RECEPTION', 'Receptionist'], ['housekeeping', 'Nguyen Buong Phong', 'HOUSEKEEPING', 'Housekeeper'], ['restaurant', 'Vo Phuc Vu', 'RESTAURANT', 'Waiter'], ['kitchen', 'Do Bep Truong', 'KITCHEN', 'Cook'], ['maintenance', 'Bui Ky Thuat', 'MAINTENANCE', 'Technician']];
  for (const [slug, name, department, jobTitle] of staffDefs) {
    const u = await user(`${slug}@hotel.local`, name, ROLES.STAFF, { createdBy: admin._id });
    await ensure('staffProfiles', M.StaffProfile, { userId: u._id }, { userId: u._id, employeeCode: await counterService.formatted('employee', 'EMP'), department, jobTitle, managerId: m1._id });
  }
  for (const i of [1, 2, 3]) await user(`guest${i}@hotel.local`, `Khach Hang ${i}`, ROLES.CUSTOMER);

  const types = {};
  for (const [name, capacity, basePriceMinor, amenities, rates] of [
    ['Single', 1, 600_000, ['wifi', 'tv', 'air-conditioning'], []], ['Double', 2, 900_000, ['wifi', 'tv', 'air-conditioning', 'minibar'], []],
    ['Deluxe', 3, 1_200_000, ['wifi', 'tv', 'air-conditioning', 'minibar', 'balcony'], []],
    ['Suite', 4, 1_800_000, ['wifi', 'tv', 'air-conditioning', 'minibar', 'balcony', 'bathtub'], [{ name: 'New Year peak', from: '2026-12-20', to: '2027-01-05', priceMinor: 2_600_000 }]],
  ]) types[name] = await ensure('roomTypes', M.RoomType, { name }, { name, capacity, basePriceMinor, amenities, rates, description: `${name} room` });
  const layout = ['Single', 'Double', 'Double', 'Deluxe', 'Suite'];
  for (let floor = 1; floor <= 3; floor += 1) {
    for (const [i, t] of layout.entries()) await ensure('rooms', M.Room, { roomNumber: `${floor}0${i + 1}` }, { roomNumber: `${floor}0${i + 1}`, floor, roomTypeId: types[t]._id });
  }

  for (const [catName, items] of [['Breakfast', [['Pho bo', 80_000], ['Banh mi op la', 60_000]]], ['Main course', [['Com chien hai san', 120_000], ['Bun cha', 90_000]]], ['Beverages', [['Ca phe sua da', 35_000], ['Nuoc cam', 40_000]]]]) {
    const cat = await ensure('menuCategories', M.MenuCategory, { name: catName }, { name: catName });
    for (const [name, priceMinor] of items) await ensure('menuItems', M.MenuItem, { name, categoryId: cat._id }, { name, categoryId: cat._id, priceMinor });
  }
  for (const [name, category, priceMinor, pricingType] of [['Laundry', 'LAUNDRY', 40_000, 'PER_UNIT'], ['Spa massage (60 min)', 'SPA', 500_000, 'PER_PERSON'], ['Airport transfer', 'TRANSPORT', 350_000, 'FIXED'], ['Extra bed', 'EXTRA_BED', 200_000, 'PER_UNIT'], ['Room decoration', 'DECORATION', 600_000, 'FIXED']]) await ensure('services', M.HotelService, { name }, { name, category, priceMinor, pricingType });

  const facilities = {};
  for (const [name, type] of [['Gym', 'GYM'], ['Restaurant', 'RESTAURANT'], ['Kitchen', 'KITCHEN'], ['Swimming pool', 'SWIMMING_POOL'], ['Spa', 'SPA'], ['Reception', 'RECEPTION'], ['Laundry', 'LAUNDRY'], ['Parking', 'PARKING']]) facilities[name] = await ensure('facilities', M.Facility, { name }, { name, type, managerId: m1._id, operatingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '06:00', close: '22:00' })) });
  for (const [name, facility, category, intervalDays] of [['Treadmill', 'Gym', 'Cardio', 90], ['Exercise bike', 'Gym', 'Cardio', 90], ['Walk-in refrigerator', 'Kitchen', 'Cooling', 60], ['Combi oven', 'Kitchen', 'Cooking', 60], ['Pool pump', 'Swimming pool', 'Filtration', 30]]) {
    await ensure('equipment', M.Equipment, { name, facilityId: facilities[facility]._id }, { name, facilityId: facilities[facility]._id, category, equipmentCode: await counterService.formatted('equipment', 'EQ', 5), maintenanceIntervalDays: intervalDays, nextMaintenanceAt: new Date(Date.now() + intervalDays * 86_400_000) });
  }

  logger.info(`Seed complete. Created: ${JSON.stringify(created) === '{}' ? 'nothing new (already seeded)' : JSON.stringify(created)}. Hotel timezone ${settings.timezone}, currency ${settings.currency}.`);
  // eslint-disable-next-line no-console
  console.log(`\nLogin accounts (all use the same password${generated ? ', generated now. Save it, it is not stored' : ' from SEED_PASSWORD'}):\n  password: ${password}\n  ${['admin', 'manager1', 'manager2', 'reception', 'housekeeping', 'restaurant', 'kitchen', 'maintenance', 'guest1'].map((s) => (s === 'admin' ? admin.email : `${s}@hotel.local`)).join('\n  ')}\n`);
} catch (err) {
  logger.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
