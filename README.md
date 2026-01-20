# Oz Tank POD Manager

Service Proof of Delivery (POD) management system for Oz Tank.

## Features

- Service POD creation with photo and signature capture
- Google Calendar integration for service scheduling
- Worker and Admin views
- Tank movement tracking
- Ad-hoc service/delivery support
- Export to Excel/PDF

## Tech Stack

- Static HTML/JavaScript
- Supabase (PostgreSQL database)
- Google Sign-In authentication

## Deployment

This app is deployed on Vercel and connects to a Supabase database.

### Environment

- **Database**: Supabase (existing instance)
- **Auth**: Google OAuth 2.0
- **Hosting**: Vercel

## Access Control

Access is restricted to authorized Oz Tank Google accounts only.
