#!/usr/bin/env node

/**
 * Device Management CLI for Aviant Push Bridge
 * 
 * Usage:
 *   node manage-devices.js list              - List all registered devices
 *   node manage-devices.js delete <token>    - Delete a specific device
 *   node manage-devices.js clean             - Remove all devices (fresh start)
 */

const axios = require('axios');
const readline = require('readline');

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3002';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer);
    });
  });
}

async function listDevices() {
  try {
    console.log('📱 Fetching registered devices...\n');
    
    const response = await axios.get(`${BRIDGE_URL}/devices`);
    const { count, devices } = response.data;
    
    if (count === 0) {
      console.log('✅ No devices registered.\n');
      return [];
    }
    
    console.log(`📊 Total devices: ${count}\n`);
    console.log('═'.repeat(80));
    
    devices.forEach((device, index) => {
      console.log(`\n🔹 Device ${index + 1}:`);
      console.log(`   Name:       ${device.name || device.deviceName || 'Unknown'}`);
      console.log(`   Model:      ${device.model || device.deviceModel || 'Unknown'}`);
      console.log(`   Platform:   ${device.platform || 'Unknown'}`);
      console.log(`   Token Type: ${device.tokenType || 'Unknown'}`);
      console.log(`   Token:      ${device.token}`);
      console.log(`   Registered: ${device.registeredAt || 'Unknown'}`);
      console.log(`   Last Seen:  ${device.lastSeen || device.lastUsed || 'Never'}`);
    });
    
    console.log('\n' + '═'.repeat(80) + '\n');
    
    return devices;
    
  } catch (error) {
    console.error('❌ Error fetching devices:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error(`\n⚠️  Bridge not running at ${BRIDGE_URL}`);
      console.error('   Make sure your bridge is started.\n');
    }
    return [];
  }
}

async function deleteDevice(token) {
  try {
    console.log(`🗑️  Deleting device with token: ${token}...\n`);
    
    const response = await axios.delete(`${BRIDGE_URL}/devices/${token}`);
    
    if (response.data.success) {
      console.log('✅ Device removed successfully!\n');
      return true;
    } else {
      console.log('❌ Failed to remove device.\n');
      return false;
    }
    
  } catch (error) {
    if (error.response?.status === 404) {
      console.error('❌ Device not found. Check the token and try again.\n');
    } else {
      console.error('❌ Error deleting device:', error.message, '\n');
    }
    return false;
  }
}

async function cleanAllDevices() {
  const devices = await listDevices();
  
  if (devices.length === 0) {
    return;
  }
  
  console.log('⚠️  WARNING: This will remove ALL registered devices!');
  const answer = await prompt('Are you sure? Type "yes" to confirm: ');
  
  if (answer.toLowerCase() !== 'yes') {
    console.log('\n❌ Cancelled. No devices removed.\n');
    return;
  }
  
  console.log('\n🗑️  Removing all devices...\n');
  
  let successCount = 0;
  for (const device of devices) {
    const success = await deleteDevice(device.token);
    if (success) successCount++;
  }
  
  console.log(`✅ Removed ${successCount}/${devices.length} devices.\n`);
  console.log('💡 You can now re-register your active devices in the app.\n');
}

async function interactiveDelete() {
  const devices = await listDevices();
  
  if (devices.length === 0) {
    return;
  }
  
  console.log('Which device would you like to delete?');
  console.log('Enter the device number, token prefix, or "cancel":\n');
  
  const answer = await prompt('> ');
  
  if (answer.toLowerCase() === 'cancel') {
    console.log('\n❌ Cancelled.\n');
    return;
  }
  
  // Try as device number first
  const deviceNum = parseInt(answer);
  if (!isNaN(deviceNum) && deviceNum >= 1 && deviceNum <= devices.length) {
    const device = devices[deviceNum - 1];
    await deleteDevice(device.token);
    return;
  }
  
  // Try as token prefix
  const matchingDevice = devices.find(d => d.token.startsWith(answer));
  if (matchingDevice) {
    await deleteDevice(matchingDevice.token);
    return;
  }
  
  console.log('\n❌ Invalid selection. Please run again.\n');
}

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];
  
  console.log('\n🌉 Aviant Push Bridge - Device Manager\n');
  
  if (!command || command === 'list') {
    await listDevices();
  } else if (command === 'delete') {
    if (arg) {
      await deleteDevice(arg);
    } else {
      await interactiveDelete();
    }
  } else if (command === 'clean') {
    await cleanAllDevices();
  } else if (command === 'help') {
    console.log('Usage:');
    console.log('  node manage-devices.js list              - List all registered devices');
    console.log('  node manage-devices.js delete [token]    - Delete a specific device');
    console.log('  node manage-devices.js clean             - Remove all devices');
    console.log('  node manage-devices.js help              - Show this help\n');
    console.log('Environment Variables:');
    console.log('  BRIDGE_URL - Bridge URL (default: http://localhost:3002)\n');
  } else {
    console.log(`❌ Unknown command: ${command}`);
    console.log('Run "node manage-devices.js help" for usage.\n');
  }
  
  rl.close();
}

main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  rl.close();
  process.exit(1);
});
