import React, { useState } from 'react';
import type { Contact, NewContact } from '../types';
import { 
  Plus, 
  Search, 
  PhoneCall, 
  UserCheck, 
  UserX, 
  Edit, 
  Trash2, 
  X, 
  ShieldAlert,
  Calendar,
  AlertCircle
} from 'lucide-react';

interface ContactsViewProps {
  contacts: Contact[];
  onAddContact: (contact: NewContact) => void;
  onUpdateContact: (id: number, updates: Partial<Contact>) => void;
  onDeleteContact: (id: number) => void;
}

export const ContactsView: React.FC<ContactsViewProps> = ({
  contacts,
  onAddContact,
  onUpdateContact,
  onDeleteContact,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  // Modal States
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [deletingContactId, setDeletingContactId] = useState<number | null>(null);

  // Form State
  const [nameInput, setNameInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [isActiveInput, setIsActiveInput] = useState(true);

  const resetForm = () => {
    setNameInput('');
    setPhoneInput('');
    setIsActiveInput(true);
    setEditingContact(null);
  };

  const openAddModal = () => {
    resetForm();
    setIsAddModalOpen(true);
  };

  const openEditModal = (contact: Contact) => {
    setEditingContact(contact);
    setNameInput(contact.name);
    setPhoneInput(contact.phone_number);
    setIsActiveInput(contact.is_active);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim() || !phoneInput.trim()) return;

    onAddContact({
      name: nameInput.trim(),
      phone_number: phoneInput.trim(),
      is_active: isActiveInput,
    });
    setIsAddModalOpen(false);
    resetForm();
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingContact || !nameInput.trim() || !phoneInput.trim()) return;

    onUpdateContact(editingContact.id, {
      name: nameInput.trim(),
      phone_number: phoneInput.trim(),
      is_active: isActiveInput,
    });
    setEditingContact(null);
    resetForm();
  };

  const handleConfirmDelete = () => {
    if (deletingContactId) {
      onDeleteContact(deletingContactId);
      setDeletingContactId(null);
    }
  };

  const filteredContacts = contacts.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.phone_number.includes(searchTerm);
    const matchesStatus =
      statusFilter === 'all'
        ? true
        : statusFilter === 'active'
        ? c.is_active
        : !c.is_active;

    return matchesSearch && matchesStatus;
  });

  return (
    <div className="contacts-view">
      {/* View Header */}
      <div className="view-header">
        <div>
          <h2 className="view-title">Emergency Alert Contacts</h2>
          <p className="view-subtitle">Manage personnel notified during critical climate or squeal alerts</p>
        </div>
        <button className="primary-btn" onClick={openAddModal}>
          <Plus className="btn-icon" /> Add New Contact
        </button>
      </div>

      {/* Filter & Search Bar */}
      <div className="filter-toolbar">
        <div className="search-input-wrapper">
          <Search className="search-icon" />
          <input
            type="text"
            placeholder="Search contact by name or phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="filter-group">
          <button
            className={`filter-tab ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All ({contacts.length})
          </button>
          <button
            className={`filter-tab ${statusFilter === 'active' ? 'active' : ''}`}
            onClick={() => setStatusFilter('active')}
          >
            Active ({contacts.filter((c) => c.is_active).length})
          </button>
          <button
            className={`filter-tab ${statusFilter === 'inactive' ? 'active' : ''}`}
            onClick={() => setStatusFilter('inactive')}
          >
            Inactive ({contacts.filter((c) => !c.is_active).length})
          </button>
        </div>
      </div>

      {/* Contacts Cards Grid */}
      <div className="contacts-grid">
        {filteredContacts.length === 0 ? (
          <div className="empty-contacts-card">
            <ShieldAlert className="w-12 h-12 text-slate-500 mb-3" />
            <h4 className="text-lg font-semibold text-slate-200">No Contacts Found</h4>
            <p className="text-sm text-slate-400 max-w-sm text-center mt-1">
              No contacts match your query. Add your first emergency phone contact to receive alert SMS updates.
            </p>
            <button className="primary-btn mt-4" onClick={openAddModal}>
              <Plus className="w-4 h-4 mr-1.5" /> Add First Contact
            </button>
          </div>
        ) : (
          filteredContacts.map((contact) => (
            <div key={contact.id} className={`contact-card ${contact.is_active ? 'active-card' : 'inactive-card'}`}>
              <div className="contact-card-header">
                <div className="contact-avatar">
                  {contact.name.charAt(0).toUpperCase()}
                </div>
                <div className="contact-status-toggle">
                  <button
                    className={`status-toggle-btn ${contact.is_active ? 'on' : 'off'}`}
                    onClick={() => onUpdateContact(contact.id, { is_active: !contact.is_active })}
                    title={contact.is_active ? 'Click to deactivate' : 'Click to activate'}
                  >
                    {contact.is_active ? (
                      <>
                        <UserCheck className="w-3.5 h-3.5 mr-1" /> Active
                      </>
                    ) : (
                      <>
                        <UserX className="w-3.5 h-3.5 mr-1" /> Inactive
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="contact-card-body">
                <h3 className="contact-name">{contact.name}</h3>
                <div className="contact-phone-row">
                  <PhoneCall className="w-4 h-4 text-emerald-400 mr-2 flex-shrink-0" />
                  <a href={`tel:${contact.phone_number}`} className="contact-phone">
                    {contact.phone_number}
                  </a>
                </div>
                <div className="contact-meta">
                  <Calendar className="w-3.5 h-3.5 text-slate-500 mr-1.5 inline" />
                  Added {new Date(contact.created_at).toLocaleDateString()}
                </div>
              </div>

              <div className="contact-card-actions">
                <button className="contact-action-btn edit" onClick={() => openEditModal(contact)}>
                  <Edit className="w-3.5 h-3.5 mr-1" /> Edit
                </button>
                <button
                  className="contact-action-btn delete"
                  onClick={() => setDeletingContactId(contact.id)}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add Contact Modal */}
      {isAddModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsAddModalOpen(false)}>
          <div className="modal-content form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="flex items-center space-x-2">
                <PhoneCall className="w-5 h-5 text-emerald-400" />
                <h3 className="modal-title">Add Emergency Contact</h3>
              </div>
              <button className="close-btn" onClick={() => setIsAddModalOpen(false)}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddSubmit}>
              <div className="modal-body form-grid">
                <div className="form-group full-width">
                  <label className="form-label">Full Name / Role</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Dr. John Doe (Vet)"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group full-width">
                  <label className="form-label">Phone Number (with Country Code)</label>
                  <input
                    type="tel"
                    required
                    placeholder="e.g. +1 (555) 019-2834"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group full-width">
                  <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isActiveInput}
                      onChange={(e) => setIsActiveInput(e.target.checked)}
                      className="form-checkbox"
                    />
                    <span className="text-sm font-medium text-slate-200">
                      Enable SMS & Call Alerts for this Contact
                    </span>
                  </label>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setIsAddModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn">
                  Save Contact
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Contact Modal */}
      {editingContact && (
        <div className="modal-backdrop" onClick={() => setEditingContact(null)}>
          <div className="modal-content form-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="flex items-center space-x-2">
                <Edit className="w-5 h-5 text-indigo-400" />
                <h3 className="modal-title">Edit Contact #{editingContact.id}</h3>
              </div>
              <button className="close-btn" onClick={() => setEditingContact(null)}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditSubmit}>
              <div className="modal-body form-grid">
                <div className="form-group full-width">
                  <label className="form-label">Full Name / Role</label>
                  <input
                    type="text"
                    required
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group full-width">
                  <label className="form-label">Phone Number</label>
                  <input
                    type="tel"
                    required
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    className="form-input"
                  />
                </div>

                <div className="form-group full-width">
                  <label className="flex items-center space-x-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isActiveInput}
                      onChange={(e) => setIsActiveInput(e.target.checked)}
                      className="form-checkbox"
                    />
                    <span className="text-sm font-medium text-slate-200">
                      Enable Emergency SMS Alerts
                    </span>
                  </label>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setEditingContact(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn">
                  Update Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingContactId && (
        <div className="modal-backdrop" onClick={() => setDeletingContactId(null)}>
          <div className="modal-content confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="flex items-center space-x-2 text-rose-400">
                <AlertCircle className="w-6 h-6" />
                <h3 className="modal-title">Confirm Deletion</h3>
              </div>
              <button className="close-btn" onClick={() => setDeletingContactId(null)}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="modal-body">
              <p className="text-slate-300 text-sm">
                Are you sure you want to delete this emergency contact? They will no longer receive immediate alert notifications when sensor thresholds are breached.
              </p>
            </div>

            <div className="modal-footer">
              <button className="secondary-btn" onClick={() => setDeletingContactId(null)}>
                Cancel
              </button>
              <button className="danger-btn" onClick={handleConfirmDelete}>
                Delete Contact
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
